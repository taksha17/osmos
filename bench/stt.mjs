/**
 * STT + endpointing row — Architecture v2 §13.1/§13.2, Phase 2 exit criteria.
 *
 * Two measurements over the committed audio fixture set:
 *
 *   endpoint  — replay each clip's 20 ms frames through the *shipped* state
 *               machine (`src/shared/policy/vadEndpoint.ts`, bundled by
 *               `bench/run.mjs`) and compare the emitted `utterance.end` against
 *               the true last voice frame. That is the "end of question → final
 *               transcript" half the VAD owns (target p50 ≤ 600 ms).
 *   wer       — transcribe the same clips with the shipped local engine
 *               (`scripts/whisper-worker.mjs`, Moonshine q8 by default) and score
 *               word error rate against the reference text (target ≤ 12 %).
 *
 * Decode time is reported per clip too, so the row shows the honest total the
 * user waits: endpoint hangover + whole-utterance decode. A streaming engine can
 * cut the decode half (the RFC budgets 150 ms for a tail decode), but the number
 * is not hidden behind that assumption.
 *
 * Run via `BENCH_STT=1 npm run bench` (needs the fixture set and a model cache);
 * it never gates the plain deterministic bench.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const STT_GATES = { wer: 0.12, endpointP50Ms: 600 };

function readWavPcm16(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44) throw new Error('WAV file too small');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
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
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error('invalid WAV: missing fmt/data chunk');
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) throw new Error('WAV must be 16-bit PCM');
  if (fmt.sampleRate !== 16_000) throw new Error(`WAV must be 16 kHz (got ${fmt.sampleRate})`);
  if (fmt.channels !== 1) throw new Error('WAV must be mono');

  const frameCount = Math.floor(dataSize / 2);
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) samples[i] = buf.readInt16LE(dataOffset + i * 2);
  return samples;
}

function rmsOf(samples, from, to) {
  let sum = 0;
  const n = to - from;
  if (n <= 0) return 0;
  for (let i = from; i < to; i++) {
    const s = samples[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Split mono s16 samples into fixed 20 ms frames (320 samples). */
function frames(samples, frameSamples) {
  const out = [];
  for (let i = 0; i + frameSamples <= samples.length; i += frameSamples) {
    out.push(samples.subarray(i, i + frameSamples));
  }
  return out;
}

function normaliseWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference, hypothesis) {
  const ref = normaliseWords(reference);
  const hyp = normaliseWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i++) dp[i * cols] = i;
  for (let j = 0; j < cols; j++) dp[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      const del = dp[(i - 1) * cols + j] + 1;
      const ins = dp[i * cols + (j - 1)] + 1;
      const sub = dp[(i - 1) * cols + (j - 1)] + cost;
      dp[i * cols + j] = Math.min(del, ins, sub);
    }
  }
  return dp[rows * cols - 1] / ref.length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const round = (value) => Math.round(value * 1000) / 1000;

/** Replay one clip through the shipped endpoint detector. */
export function measureEndpoint(vad, samples, opts = {}) {
  const frameMs = vad.VAD_DEFAULTS.frameMs;
  const frameSamples = Math.round((16_000 * frameMs) / 1000);
  const detector = new vad.EndpointDetector(opts.params || {});
  const blocks = frames(samples, frameSamples);

  const threshold = (opts.params && opts.params.speechThreshold) ?? vad.VAD_DEFAULTS.speechThreshold;
  let lastVoiceMs = 0;
  let endEvent = null;
  let startEvent = null;
  let emittedAtMs = null;
  blocks.forEach((block, index) => {
    const ts = (index + 1) * frameMs;
    const rms = rmsOf(block, 0, block.length);
    if (rms >= threshold) lastVoiceMs = ts;
    for (const event of detector.push(rms, ts)) {
      if (event.t === 'utterance.start' && !startEvent) startEvent = event;
      if (event.t === 'utterance.end' && !endEvent) {
        endEvent = event;
        // When the detector *emitted* the end, which is what the STT engine sees.
        emittedAtMs = ts;
      }
    }
  });
  if (!endEvent) {
    // No endpoint before the clip ran out (continuous noise, or speech to the
    // last frame): flush and mark it, since a real stream would keep waiting.
    const flushed = detector.flush(blocks.length * frameMs).find((e) => e.t === 'utterance.end');
    if (flushed) {
      endEvent = flushed;
      emittedAtMs = blocks.length * frameMs;
    }
  }
  if (!endEvent) {
    return { endpointMs: null, speechMs: 0, trueEndMs: lastVoiceMs, flushed: true };
  }
  const flushed = emittedAtMs === blocks.length * frameMs;
  return {
    endpointMs: Math.max(0, Math.round(emittedAtMs - lastVoiceMs)),
    startLagMs: startEvent ? Math.max(0, Math.round(startEvent.atMs - (lastVoiceMs - endEvent.speechMs))) : null,
    speechMs: endEvent.speechMs,
    trueEndMs: lastVoiceMs,
    flushed,
  };
}

/**
 * Transcribe every clip through one warm `whisper-worker --serve` process, so
 * the row measures the engine rather than model loading on each file.
 */
async function transcribeAll({ nodeBin, workerScript, cacheDir, model, files, env }) {
  const child = spawn(nodeBin, [workerScript, '--serve', cacheDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const results = new Map();

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`whisper worker did not start: ${stderr.join('')}`)), 180_000);
    rl.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.ready) {
        clearTimeout(timer);
        resolve();
        return;
      }
      const waiter = pending.get(String(message.id));
      if (waiter) {
        pending.delete(String(message.id));
        waiter(message);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`whisper worker exited (${code}): ${stderr.join('').slice(-400)}`));
    });
  });

  await ready;

  for (const file of files) {
    const id = path.basename(file);
    const started = Date.now();
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`transcription timed out for ${id}`)), 180_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        `${JSON.stringify({ id, audioPath: file, ...(model ? { model } : {}) })}\n`,
      );
    });
    results.set(file, {
      ok: Boolean(reply.ok),
      text: reply.text ?? '',
      error: reply.error,
      decodeMs: Date.now() - started,
    });
  }

  child.stdin.end();
  child.kill();
  return results;
}

export async function evaluateStt({
  vad,
  fixturesDir,
  workerScript,
  cacheDir,
  model,
  nodeBin = process.execPath,
  env,
}) {
  const files = fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.wav'))
    .sort()
    .map((name) => path.join(fixturesDir, name));
  if (files.length === 0) {
    return { samples: 0, error: `no .wav fixtures in ${fixturesDir}` };
  }

  const transcriptions = await transcribeAll({
    nodeBin,
    workerScript,
    cacheDir,
    model,
    files,
    env,
  });

  const rows = files.map((file) => {
    const refPath = file.replace(/\.wav$/, '.txt');
    const reference = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf8').trim() : '';
    const samples = readWavPcm16(file);
    const endpoint = measureEndpoint(vad, samples);
    // The endpoint row is scored on the clean clips: a noisy variant keeps the
    // energy detector above threshold through the trailing silence, so it can
    // only report a flush, not a hangover endpoint.
    const transcription = transcriptions.get(file) ?? { ok: false, text: '', decodeMs: 0 };
    return {
      clip: path.basename(file),
      reference,
      hypothesis: transcription.text,
      error: transcription.error,
      wer: round(wordErrorRate(reference, transcription.text)),
      endpointMs: path.basename(file).includes('-noisy') ? null : endpoint.endpointMs,
      endpointFlushed: endpoint.flushed,
      speechMs: endpoint.speechMs,
      decodeMs: transcription.decodeMs,
      totalMs:
        endpoint.endpointMs === null ? null : endpoint.endpointMs + transcription.decodeMs,
    };
  });

  const werValues = rows.map((row) => row.wer);
  const cleanRows = rows.filter((row) => !row.clip.includes('-noisy'));
  const noisyRows = rows.filter((row) => row.clip.includes('-noisy'));
  const endpointValues = cleanRows.map((row) => row.endpointMs).filter((v) => v !== null);
  const flushed = rows.filter((row) => row.endpointFlushed).length;
  const decodeValues = rows.map((row) => row.decodeMs);
  const totalValues = rows.map((row) => row.totalMs).filter((v) => v !== null);

  const summary = {
    samples: rows.length,
    clips: rows.length,
    cleanClips: cleanRows.length,
    noisyClips: noisyRows.length,
    endpointClips: endpointValues.length,
    flushed,
    model: model || 'default',
    wer: round(werValues.reduce((a, b) => a + b, 0) / Math.max(1, werValues.length)),
    werP50: round(percentile(werValues, 50)),
    werWorst: round(Math.max(...werValues)),
    werClean: round(cleanRows.reduce((a, r) => a + r.wer, 0) / Math.max(1, cleanRows.length)),
    werNoisy: round(noisyRows.reduce((a, r) => a + r.wer, 0) / Math.max(1, noisyRows.length)),
    endpointP50Ms: percentile(endpointValues, 50),
    endpointP95Ms: percentile(endpointValues, 95),
    decodeP50Ms: percentile(decodeValues, 50),
    totalP50Ms: percentile(totalValues, 50),
    totalP95Ms: percentile(totalValues, 95),
    failed: rows.filter((row) => !row.hypothesis.trim()).length,
  };

  const failures = [];
  if (summary.wer > STT_GATES.wer) {
    failures.push(
      `WER ${summary.wer} above ${STT_GATES.wer} (worst clip ${summary.werWorst})`,
    );
  }
  if (summary.endpointP50Ms > STT_GATES.endpointP50Ms) {
    failures.push(
      `endpoint latency p50 ${summary.endpointP50Ms} ms above ${STT_GATES.endpointP50Ms} ms`,
    );
  }

  return { ...summary, gates: { thresholds: STT_GATES, passed: failures.length === 0, failures }, rows };
}
