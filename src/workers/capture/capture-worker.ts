#!/usr/bin/env node
/**
 * Capture worker — Architecture v2, §5.1 + §5.2.
 *
 * Runs outside the Electron main process so a stalled ffmpeg pipe can never
 * block IPC, and so endpointing happens next to the samples it measures.
 *
 * Bundled to `dist-electron/workers/capture-worker.mjs` because it imports the
 * tested shared policy (`vadEndpoint.ts`) — one implementation, no copy.
 *
 * Protocol (JSON lines on stdin/stdout):
 *   in : {"cmd":"start","channel":"mic"|"loopback","ffmpeg":"…",
 *         "inputArgs":["-f","pulse","-i","…"],"chunkMs":6000,"source":"…",
 *         "backend":"ffmpeg","overlapMs":250,"cwd":"…","vad":true}
 *        {"cmd":"stop"} · {"cmd":"ping"}
 *   out: {"type":"ready"} · {"type":"started","pid":N,"chunkMs":N,"vad":bool}
 *        {"type":"chunk",…}                       (fixed-size, legacy consumers)
 *        {"type":"utterance",…}                   (VAD-endpointed, §5.2)
 *        {"type":"beat","tsMs":N} · {"type":"exit",…} · {"type":"error",…}
 *
 * Backend selection stays in main (it needs pactl / dshow / AVFoundation
 * enumeration). Hard rule carried over: never `parec` — main never sends it.
 */

import { spawn } from 'node:child_process';
import {
  EndpointDetector,
  FRAME_BYTES_16K_MONO,
  splitFrames,
} from '../../shared/policy/vadEndpoint.ts';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
const MIN_CHUNK_MS = 2_000;
const MAX_CHUNK_MS = 15_000;
const BEAT_MS = 1_000;
const SILENCE_RMS = 0.006;

type StartCommand = {
  cmd: 'start';
  channel: 'mic' | 'loopback';
  ffmpeg: string;
  inputArgs: string[];
  chunkMs?: number;
  source?: string;
  backend?: string;
  overlapMs?: number;
  cwd?: string;
  vad?: boolean;
};

let child: ReturnType<typeof spawn> | null = null;
let config: StartCommand | null = null;
let chunks: Buffer[] = [];
let bytesWanted = 0;
let tail = Buffer.alloc(0);
let overlapBytes = 0;
let beatTimer: NodeJS.Timeout | null = null;
let stopping = false;
let stderrTail = '';

// Endpointing state (§5.2).
let vad: EndpointDetector | null = null;
let frameCarry = Buffer.alloc(0);
let preRoll: Buffer[] = [];
let preRollLimit = 0;
let utterance: Buffer[] = [];
let utteranceActive = false;
let pcmMs = 0;

function emit(message: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* stdout closed — supervisor restarts us */
  }
}

function wrapPcmS16leAsWav(pcm: Buffer): Buffer {
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

function pcmRms(pcm: Buffer): number {
  if (pcm.length < 4) return 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples) / 32768;
}

function killChild(): void {
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

function stop(): void {
  if (beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
  killChild();
  chunks = [];
  tail = Buffer.alloc(0);
  stderrTail = '';
  vad?.reset();
  frameCarry = Buffer.alloc(0);
  preRoll = [];
  utterance = [];
  utteranceActive = false;
  pcmMs = 0;
}

/** Feed one 20 ms frame through the detector and the utterance buffer. */
function handleFrame(frame: Buffer, alreadyBuffered: boolean): void {
  if (!vad) return;
  pcmMs += 20;
  const rms = pcmRms(frame);
  const snapshot = preRoll;

  for (const event of vad.push(rms, pcmMs)) {
    if (event.t === 'utterance.start') {
      utteranceActive = true;
      utterance = [...snapshot, frame];
    } else {
      if (utteranceActive) utterance.push(frame);
      const pcm = Buffer.concat(utterance);
      utterance = [];
      utteranceActive = false;
      if (pcm.length >= FRAME_BYTES_16K_MONO * 5) {
        emit({
          type: 'utterance',
          channel: config?.channel ?? 'mic',
          base64: wrapPcmS16leAsWav(pcm).toString('base64'),
          startMs: event.startMs,
          endMs: event.endMs,
          speechMs: event.speechMs,
          reason: event.reason,
          source: config?.source ?? '',
          backend: config?.backend ?? 'ffmpeg',
        });
      }
    }
  }

  // Pre-roll ring: keep the last `preRollLimit` frames for the next onset.
  if (preRollLimit > 0) {
    preRoll.push(Buffer.from(frame));
    if (preRoll.length > preRollLimit) preRoll.splice(0, preRoll.length - preRollLimit);
  }

  if (utteranceActive && !alreadyBuffered) {
    // Frame arrived after the start event within the same push.
    utterance.push(frame);
  }
}

function drainFrames(data: Buffer): void {
  const { frames, rest } = splitFrames(Buffer.concat([frameCarry, data]), FRAME_BYTES_16K_MONO);
  frameCarry = Buffer.from(rest);
  for (const frame of frames) {
    const wasActive = utteranceActive;
    handleFrame(frame, false);
    // handleFrame already appended to the utterance when it was active.
    if (wasActive && utteranceActive && utterance.length > 0) {
      const last = utterance[utterance.length - 1];
      if (last !== frame && !last.equals(frame)) utterance.push(frame);
    }
  }
}

function start(cmd: StartCommand): void {
  stop();
  stopping = false;
  config = cmd;
  vad = cmd.vad === false ? null : new EndpointDetector();
  if (vad) {
    // 300 ms of pre-roll at 20 ms per frame.
    preRollLimit = Math.max(1, Math.round(300 / 20));
  }

  const chunkMs = Math.max(MIN_CHUNK_MS, Math.min(MAX_CHUNK_MS, Number(cmd.chunkMs) || 6_000));
  bytesWanted = Math.floor((BYTES_PER_SECOND * chunkMs) / 1000);
  overlapBytes = Math.max(0, Math.floor((BYTES_PER_SECOND * (Number(cmd.overlapMs) || 0)) / 1000));

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

  let proc: ReturnType<typeof spawn>;
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
  emit({ type: 'started', pid: proc.pid, chunkMs, vad: Boolean(vad) });

  proc.stdout?.on('data', (buf: Buffer) => {
    drainFrames(buf);

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
      const rms = pcmRms(slice);
      emit({
        type: 'chunk',
        channel: config?.channel ?? 'mic',
        base64: wrapPcmS16leAsWav(slice).toString('base64'),
        rms,
        silent: rms < SILENCE_RMS,
        source: config?.source ?? '',
        backend: config?.backend ?? 'ffmpeg',
      });
    }
  });

  proc.stderr?.on('data', (buf: Buffer) => {
    stderrTail += buf.toString('utf8');
    if (stderrTail.length > 4_096) stderrTail = stderrTail.slice(-4_096);
  });

  proc.on('error', (error: Error) => {
    emit({ type: 'error', error: error.message || 'ffmpeg failed' });
  });

  proc.on('close', (code: number | null) => {
    if (stopping) return;
    emit({ type: 'exit', code, stderrTail: stderrTail.trim().slice(-800) });
    // Exit so the supervisor applies its restart policy instead of us
    // re-implementing backoff in two places.
    process.exit(0);
  });

  beatTimer = setInterval(() => emit({ type: 'beat', tsMs: Date.now() }), BEAT_MS);
}

function handle(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd: { cmd?: string };
  try {
    cmd = JSON.parse(trimmed) as { cmd?: string };
  } catch {
    emit({ type: 'error', error: 'invalid JSON command' });
    return;
  }

  if (cmd.cmd === 'start') start(cmd as StartCommand);
  else if (cmd.cmd === 'stop') {
    stopping = true;
    stop();
    emit({ type: 'stopped' });
  } else if (cmd.cmd === 'ping') emit({ type: 'pong', tsMs: Date.now() });
  else emit({ type: 'error', error: `unknown command ${String(cmd.cmd)}` });
}

let buffer = '';
process.stdin.on('data', (data: Buffer) => {
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
