#!/usr/bin/env node
/**
 * Standalone Whisper worker (system Node, not Electron).
 *
 * One-shot:
 *   node scripts/whisper-worker.mjs <audioPath> <cacheDir>
 *
 * Persistent (keeps model warm for continuous STT):
 *   node scripts/whisper-worker.mjs --serve <cacheDir>
 *   stdin:  one JSON line per request { "id": "...", "audioPath": "..." }
 *   stdout: one JSON line per response { "id", "ok", "text?"|"error?" }
 *
 * Audio must be WAV (PCM). The renderer converts mic recordings to 16 kHz mono WAV.
 */

import { pipeline, env } from '@xenova/transformers';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root =
  process.env.OSMOS_ROOT ||
  process.env.UNCON_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const serveMode = process.argv.includes('--serve');
const positional = process.argv.filter((a) => a !== '--serve' && !a.endsWith('whisper-worker.mjs'));
const audioPath = serveMode ? null : positional[0];
const cacheDir = (serveMode ? positional[0] : positional[1]) || path.join(root, '.whisper-cache');

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

async function loadAsr() {
  return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
}

async function transcribeFile(asr, filePath) {
  const { samples, sampleRate } = readWavPcm(filePath);
  if (samples.length < 1600) throw new Error('Recording too short — speak a bit longer.');
  const result = await asr(samples, {
    sampling_rate: sampleRate,
    language: 'english',
    task: 'transcribe',
    return_timestamps: false,
  });
  return String(result?.text || '').trim();
}

if (serveMode) {
  let asr = null;
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
    try {
      if (!asr) asr = await loadAsr();
      const text = await transcribeFile(asr, req.audioPath);
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

try {
  const asr = await loadAsr();
  const text = await transcribeFile(asr, audioPath);
  process.stdout.write(JSON.stringify({ ok: true, text }) + '\n');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
