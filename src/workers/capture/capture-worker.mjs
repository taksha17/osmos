#!/usr/bin/env node
/**
 * Capture worker — Architecture v2, §5.1.
 *
 * Runs outside the Electron main process so a stalled ffmpeg pipe can never
 * block IPC. Speaks JSON lines on stdin/stdout:
 *
 *   in : {"cmd":"start","channel":"mic"|"loopback","ffmpeg":"/path/ffmpeg",
 *         "inputArgs":["-f","pulse","-i","alsa…monitor"],"chunkMs":6000,
 *         "source":"…","backend":"ffmpeg"|"pw-record","overlapMs":250,"cwd":"…"}
 *        {"cmd":"stop"} · {"cmd":"ping"}
 *   out: {"type":"ready"} · {"type":"started","pid":N}
 *        {"type":"chunk","channel":"…","base64":"…","rms":0.01,"silent":false,
 *         "source":"…","backend":"ffmpeg"}
 *        {"type":"beat","tsMs":N} · {"type":"exit","code":N,"stderrTail":"…"}
 *        {"type":"error","error":"…"}
 *
 * Backend selection stays in main (it needs pactl / dshow / AVFoundation
 * enumeration); this worker only runs the ffmpeg pipeline it is handed.
 * Hard rule carried over: never `parec` — main never sends it.
 */

import { spawn } from 'node:child_process';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const SILENCE_RMS = 0.006;
const MIN_CHUNK_MS = 2_000;
const MAX_CHUNK_MS = 15_000;
const BEAT_MS = 1_000;

let child = null;
let config = null;
let chunks = [];
let bytesWanted = 0;
let tail = Buffer.alloc(0);
let overlapBytes = 0;
let beatTimer = null;
let stopping = false;
let stderrTail = '';

function emit(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* stdout closed — supervisor will restart us */
  }
}

function wrapPcmS16leAsWav(pcm) {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function pcmRms(pcm) {
  if (pcm.length < 4) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples) / 32768;
}

function emitChunk(pcm) {
  const rms = pcmRms(pcm);
  emit({
    type: 'chunk',
    channel: config?.channel ?? 'mic',
    base64: wrapPcmS16leAsWav(pcm).toString('base64'),
    rms,
    silent: rms < SILENCE_RMS,
    source: config?.source ?? '',
    backend: config?.backend ?? 'ffmpeg',
  });
}

function killChild() {
  const running = child;
  child = null;
  if (!running) return;
  try {
    running.stdout?.removeAllListeners();
    running.stderr?.removeAllListeners();
    running.removeAllListeners();
    running.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function stop() {
  if (beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
  killChild();
  chunks = [];
  tail = Buffer.alloc(0);
  stderrTail = '';
}

function start(cmd) {
  stop();
  stopping = false;
  config = cmd;

  const chunkMs = Math.max(MIN_CHUNK_MS, Math.min(MAX_CHUNK_MS, Number(cmd.chunkMs) || 6_000));
  const bytesPerSecond = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  bytesWanted = Math.floor((bytesPerSecond * chunkMs) / 1000);
  overlapBytes = Math.max(0, Math.floor((bytesPerSecond * (Number(cmd.overlapMs) || 0)) / 1000));

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(Array.isArray(cmd.inputArgs) ? cmd.inputArgs : []),
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ];

  let proc;
  try {
    proc = spawn(cmd.ffmpeg, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined,
    });
  } catch (error) {
    emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  child = proc;
  emit({ type: 'started', pid: proc.pid, chunkMs });

  proc.stdout?.on('data', (buf) => {
    const joined = overlapBytes > 0 && tail.length ? Buffer.concat([tail, buf]) : buf;
    if (overlapBytes > 0 && joined.length > overlapBytes) {
      tail = Buffer.from(joined.subarray(joined.length - overlapBytes));
    }

    chunks.push(joined);
    let total = chunks.reduce((n, b) => n + b.length, 0);
    while (total >= bytesWanted) {
      const all = Buffer.concat(chunks);
      const slice = all.subarray(0, bytesWanted);
      const rest = all.subarray(bytesWanted);
      chunks = rest.length ? [rest] : [];
      total = rest.length;
      emitChunk(slice);
    }
  });

  proc.stderr?.on('data', (buf) => {
    stderrTail += buf.toString('utf8');
    if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
  });

  proc.on('error', (error) => {
    emit({ type: 'error', error: error.message || 'ffmpeg failed' });
  });

  proc.on('close', (code) => {
    if (stopping) return;
    emit({ type: 'exit', code, stderrTail: stderrTail.trim().slice(-800) });
    // Exit so the supervisor applies its restart policy instead of us
    // re-implementing backoff in two places.
    process.exit(0);
  });

  beatTimer = setInterval(() => emit({ type: 'beat', tsMs: Date.now() }), BEAT_MS);
}

function handle(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    emit({ type: 'error', error: 'invalid JSON command' });
    return;
  }

  if (cmd.cmd === 'start') start(cmd);
  else if (cmd.cmd === 'stop') {
    stopping = true;
    stop();
    emit({ type: 'stopped' });
  } else if (cmd.cmd === 'ping') emit({ type: 'pong', tsMs: Date.now() });
  else emit({ type: 'error', error: `unknown command ${String(cmd.cmd)}` });
}

let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    handle(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  stopping = true;
  stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopping = true;
  stop();
  process.exit(0);
});

emit({ type: 'ready', pid: process.pid });
