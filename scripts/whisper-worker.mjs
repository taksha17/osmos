#!/usr/bin/env node
/**
 * Standalone STT worker (system Node, not Electron).
 *
 * One-shot:
 *   node scripts/whisper-worker.mjs <audioPath> <cacheDir> [modelId]
 *
 * Persistent (keeps model warm for continuous STT):
 *   node scripts/whisper-worker.mjs --serve <cacheDir>
 *   stdin:  one JSON line per request { "id": "...", "audioPath": "...", "model"?: "..." }
 *   stdout: one JSON line per response { "id", "ok", "text?"|"error?" }
 *
 * Audio must be WAV (PCM). The renderer converts mic recordings to 16 kHz mono WAV.
 *
 * Supported models (transformers.js v3+ / ONNX):
 *   - onnx-community/moonshine-tiny-ONNX  (MIT, fast streaming STT — default)
 *   - Xenova/whisper-base.en              (MIT, strong on accents)
 */

import { pipeline, env } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root =
  process.env.OSMOS_ROOT ||
  process.env.UNCON_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const serveMode = args.includes('--serve');
const positional = args.filter((a) => a !== '--serve');
const audioPath = serveMode ? null : positional[0];
const cacheDir = positional[serveMode ? 0 : 1] || path.join(root, '.whisper-cache');

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  process.exit(1);
}

/**
 * Minimal WAV PCM reader → Float32Array samples + sample rate.
 * Supports 16-bit PCM mono/stereo; stereo is mixed to mono.
 */
function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44) throw new Error('WAV file too small');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file — Local Whisper expects WAV from the app');
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        numChannels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error('Invalid WAV: missing fmt/data chunk');
  if (fmt.audioFormat !== 1) throw new Error(`Unsupported WAV format ${fmt.audioFormat} (need PCM)`);
  if (fmt.bitsPerSample !== 16) throw new Error(`Unsupported bits/sample ${fmt.bitsPerSample} (need 16)`);

  const bytesPerSample = 2;
  const frameSize = bytesPerSample * fmt.numChannels;
  const frameCount = Math.floor(dataSize / frameSize);
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const frame = dataOffset + i * frameSize;
    if (fmt.numChannels === 1) {
      mono[i] = buf.readInt16LE(frame) / 32768;
    } else {
      const left = buf.readInt16LE(frame) / 32768;
      const right = buf.readInt16LE(frame + 2) / 32768;
      mono[i] = (left + right) / 2;
    }
  }

  return { samples: mono, sampleRate: fmt.sampleRate };
}

env.cacheDir = cacheDir;
env.allowLocalModels = false;

// Moonshine tiny is fast enough for real-time chunk transcription on CPU.
// Override with OSMOS_WHISPER_MODEL if needed (e.g. Xenova/whisper-base.en).
const DEFAULT_MODEL = process.env.OSMOS_WHISPER_MODEL || 'onnx-community/moonshine-tiny-ONNX';

const isWhisper = (m) => /whisper/i.test(m);
const isMoonshine = (m) => /moonshine/i.test(m);
// English-only whisper variants (.en) reject the language/task args.
const isEnOnly = (m) => /\.en$/i.test(m);

async function loadAsr(modelId) {
  // Moonshine's fp32 ONNX export silently outputs empty text — q8 is the
  // quantization the upstream team ships as default and works reliably.
  const opts = isMoonshine(modelId) ? { dtype: 'q8' } : {};
  return pipeline('automatic-speech-recognition', modelId, opts);
}

/**
 * Trim leading/trailing silence from a clip.
 *
 * Moonshine is trained on speech-only segments: a second of digital silence in
 * front makes it return an empty string on otherwise clean audio (measured on
 * the Phase 2 fixture set — two clips came back blank until trimmed). The VAD
 * already trims most of it in the live path, but a 300 ms pre-roll and a 450 ms
 * hangover remain, and one-shot recorder uploads carry more.
 */
function trimSilence(samples, sampleRate, opts = {}) {
  const threshold = opts.threshold ?? 10 ** (-45 / 20);
  const keepMs = opts.keepMs ?? 50;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start += 1;
  if (start >= samples.length) return samples; // all silence: let the model answer
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < threshold) end -= 1;

  const keep = Math.round((sampleRate * keepMs) / 1000);
  const from = Math.max(0, start - keep);
  const to = Math.min(samples.length, end + keep + 1);
  // Never hand the model a fragment shorter than the 100 ms it needs.
  if (to - from < Math.round(sampleRate * 0.1)) return samples;
  return samples.subarray(from, to);
}

async function transcribeFile(asr, modelId, filePath) {
  const { samples: raw, sampleRate } = readWavPcm(filePath);
  if (raw.length < 1600) throw new Error('Recording too short — speak a bit longer.');
  const samples = trimSilence(raw, sampleRate);
  const opts = { sampling_rate: sampleRate, return_timestamps: false };
  if (isWhisper(modelId) && !isEnOnly(modelId)) {
    opts.language = 'english';
    opts.task = 'transcribe';
  }
  const result = await asr(samples, opts);
  return String(result?.text || '').trim();
}

if (serveMode) {
  /** Warm ASR instances keyed by model id — switching models keeps both warm. */
  const asrs = new Map();
  async function getAsr(modelId) {
    if (!asrs.has(modelId)) asrs.set(modelId, await loadAsr(modelId));
    return asrs.get(modelId);
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  process.stdout.write(JSON.stringify({ ok: true, ready: true }) + '\n');

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: 'invalid JSON request' }) + '\n');
      continue;
    }
    const id = req.id || '';
    const modelId = typeof req.model === 'string' && req.model ? req.model : DEFAULT_MODEL;
    try {
      const asr = await getAsr(modelId);
      const text = await transcribeFile(asr, modelId, req.audioPath);
      process.stdout.write(JSON.stringify({ id, ok: true, text }) + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }) + '\n',
      );
    }
  }
  process.exit(0);
}

if (!audioPath) fail('missing audio path');
const oneShotModel = positional[2] || DEFAULT_MODEL;

try {
  const asr = await loadAsr(oneShotModel);
  const text = await transcribeFile(asr, oneShotModel, audioPath);
  process.stdout.write(JSON.stringify({ ok: true, text }) + '\n');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
