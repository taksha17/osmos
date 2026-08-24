/**
 * Long-lived Linux meeting-audio loopback (PipeWire / Pulse).
 *
 * On this Zenbook-class PipeWire stack, `parec` often records **zero bytes**
 * from sink monitors. Working tools:
 *   - ffmpeg -f pulse -i <sink.monitor>
 *   - pw-record --target=<sink.monitor>
 *
 * Continuous path: ffmpeg writes s16le PCM to stdout; we slice into WAV chunks.
 * Fallback: timed pw-record file captures in a loop (same process owner).
 */

import { spawn, type ChildProcess, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { resolveCaptureTool, resolveFfmpeg, safeSpawnCwd } from './resolveBin.js';
import {
  listLinuxAudioDevices,
  resolveLinuxMonitor,
} from './audioDevices.js';

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

export type LoopbackChunk = {
  ok: true;
  base64: string;
  mimeType: 'audio/wav';
  rms: number;
  silent: boolean;
  monitor: string;
  backend: 'ffmpeg' | 'pw-record';
};

function wrapPcmS16leAsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
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

async function defaultSink(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('pactl', ['get-default-sink'], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

type StartOpts = {
  device?: string;
  chunkMs?: number;
};

export class LinuxLoopbackStream extends EventEmitter {
  private child: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private bytesWanted = 0;
  private chunkMs = 6000;
  private monitor = '';
  private requestedDevice = '';
  private running = false;
  private sinkWatch: ReturnType<typeof setInterval> | null = null;
  private lastDefaultSink = '';
  private remounting = false;
  private backend: 'ffmpeg' | 'pw-record' | null = null;
  private pwLoopTimer: ReturnType<typeof setTimeout> | null = null;

  get isRunning() {
    return this.running;
  }

  async start(opts: StartOpts = {}): Promise<{ ok: boolean; error?: string; monitor?: string; backend?: string }> {
    if (this.running) await this.stop();
    this.chunkMs = Math.max(2000, Math.min(15_000, opts.chunkMs || 6000));
    this.bytesWanted = Math.floor((SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * this.chunkMs) / 1000);
    this.requestedDevice = (opts.device || '').trim();
    this.running = true;

    const opened = await this.mountCapture();
    if (!opened.ok) {
      this.running = false;
      return opened;
    }

    this.lastDefaultSink = await defaultSink();
    this.sinkWatch = setInterval(() => {
      void this.checkRouteChange();
    }, 2500);

    return { ok: true, monitor: this.monitor, backend: this.backend || undefined };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sinkWatch) {
      clearInterval(this.sinkWatch);
      this.sinkWatch = null;
    }
    if (this.pwLoopTimer) {
      clearTimeout(this.pwLoopTimer);
      this.pwLoopTimer = null;
    }
    this.killChild();
    this.chunks = [];
    this.backend = null;
  }

  private killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  private async resolveMonitor(): Promise<string> {
    const list = await listLinuxAudioDevices();
    let monitor = resolveLinuxMonitor(this.requestedDevice || undefined, list);
    if (!monitor || monitor === '@DEFAULT_MONITOR@') {
      monitor =
        list.preferredMonitorId !== '@DEFAULT_MONITOR@'
          ? list.preferredMonitorId
          : list.monitors.find((m) => m.id.endsWith('.monitor'))?.id || '';
    }
    return monitor;
  }

  private async mountCapture(): Promise<{ ok: boolean; error?: string; monitor?: string; backend?: string }> {
    const monitor = await this.resolveMonitor();
    if (!monitor) {
      return {
        ok: false,
        error: 'No PipeWire/Pulse sink monitor found for meeting audio.',
      };
    }
    this.monitor = monitor;

    // 1) ffmpeg pulse → stdout (works on this machine; parec does not)
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg) {
      const ok = this.spawnFfmpegPulse(ffmpeg, monitor);
      if (ok.ok) return { ...ok, backend: 'ffmpeg' };
    }

    // 2) Timed pw-record loop (also works here)
    const pw = resolveCaptureTool('pw-record');
    if (pw) {
      this.backend = 'pw-record';
      this.emit('status', `Listening via pw-record on ${monitor}`);
      void this.pwRecordLoop(pw, monitor);
      return { ok: true, monitor, backend: 'pw-record' };
    }

    return {
      ok: false,
      error:
        'No working system-audio tool. Install ffmpeg and/or pipewire (pw-record). Note: parec often records empty audio on PipeWire.',
    };
  }

  private spawnFfmpegPulse(bin: string, monitor: string): { ok: boolean; error?: string; monitor?: string } {
    this.killChild();
    this.chunks = [];
    let child: ChildProcess;
    try {
      // -nostdin avoids ffmpeg waiting on stdin; -loglevel error keeps stderr quiet
      child = spawn(
        bin,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'pulse',
          '-i',
          monitor,
          '-ac',
          String(CHANNELS),
          '-ar',
          String(SAMPLE_RATE),
          '-f',
          's16le',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], cwd: safeSpawnCwd(), windowsHide: true },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.child = child;
    this.backend = 'ffmpeg';
    this.emit('status', `Listening via ffmpeg on ${monitor}`);

    let gotData = false;
    const startupTimer = setTimeout(() => {
      if (!this.running || gotData) return;
      // ffmpeg connected but silent is OK; only fail if process died
      if (!this.child || this.child.killed) {
        this.emit('error', 'ffmpeg pulse capture failed to start');
      }
    }, 4000);

    child.stdout?.on('data', (buf: Buffer) => {
      if (!this.running) return;
      gotData = true;
      this.chunks.push(buf);
      let total = this.chunks.reduce((n, b) => n + b.length, 0);
      while (total >= this.bytesWanted) {
        const joined = Buffer.concat(this.chunks);
        const slice = joined.subarray(0, this.bytesWanted);
        const rest = joined.subarray(this.bytesWanted);
        this.chunks = rest.length ? [rest] : [];
        total = rest.length;
        this.emitChunk(slice, 'ffmpeg');
      }
    });

    let errBuf = '';
    child.stderr?.on('data', (b: Buffer) => {
      errBuf += b.toString('utf8');
      if (errBuf.length > 800) errBuf = errBuf.slice(-800);
    });

    child.on('error', (err) => {
      clearTimeout(startupTimer);
      if (!this.running) return;
      this.emit('error', err.message || 'ffmpeg failed');
    });

    child.on('close', (code) => {
      clearTimeout(startupTimer);
      if (!this.running || this.remounting) return;
      this.emit(
        'error',
        `ffmpeg pulse stopped (code ${code})${errBuf.trim() ? `: ${errBuf.trim().slice(0, 200)}` : ''}`,
      );
    });

    return { ok: true, monitor };
  }

  /** Reliable fallback when ffmpeg pulse is unavailable: timed pw-record files. */
  private async pwRecordLoop(bin: string, monitor: string) {
    while (this.running && this.backend === 'pw-record') {
      const tmp = path.join(os.tmpdir(), `osmos-loop-${Date.now()}.wav`);
      const ok = await this.runPwRecordOnce(bin, monitor, tmp, this.chunkMs);
      if (!this.running || this.backend !== 'pw-record') {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        break;
      }
      if (ok) {
        try {
          const wav = fs.readFileSync(tmp);
          fs.unlinkSync(tmp);
          // Strip WAV header for RMS, or compute from whole file — use PCM after header
          const pcm = wav.length > 44 ? wav.subarray(44) : wav;
          const rms = pcmRms(pcm);
          this.emit('chunk', {
            ok: true as const,
            base64: wav.toString('base64'),
            mimeType: 'audio/wav' as const,
            rms,
            silent: rms < 0.006,
            monitor,
            backend: 'pw-record' as const,
          });
        } catch (e) {
          this.emit('error', e instanceof Error ? e.message : 'Failed to read pw-record wav');
          await sleep(1500);
        }
      } else {
        this.emit('error', `pw-record capture failed for ${monitor}`);
        await sleep(2000);
      }
    }
  }

  private runPwRecordOnce(bin: string, monitor: string, tmp: string, durationMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(
          bin,
          ['--rate=16000', '--channels=1', '--format=s16', `--target=${monitor}`, tmp],
          { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true },
        );
      } catch {
        resolve(false);
        return;
      }
      this.child = child;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            resolve(ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 400);
          } catch {
            resolve(false);
          }
        }, 150);
      };
      const timer = setTimeout(() => finish(true), durationMs);
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (!settled) finish(true);
      });
    });
  }

  private emitChunk(pcm: Buffer, backend: 'ffmpeg' | 'pw-record') {
    const rms = pcmRms(pcm);
    const silent = rms < 0.006;
    const wav = wrapPcmS16leAsWav(pcm, SAMPLE_RATE, CHANNELS);
    const chunk: LoopbackChunk = {
      ok: true,
      base64: wav.toString('base64'),
      mimeType: 'audio/wav',
      rms,
      silent,
      monitor: this.monitor,
      backend,
    };
    this.emit('chunk', chunk);
  }

  private async checkRouteChange() {
    if (!this.running || this.remounting || this.requestedDevice) return;
    const sink = await defaultSink();
    if (!sink || sink === this.lastDefaultSink) return;
    this.lastDefaultSink = sink;
    this.remounting = true;
    this.emit('status', `Audio output changed → remounting ${sink}.monitor`);
    try {
      if (this.pwLoopTimer) {
        clearTimeout(this.pwLoopTimer);
        this.pwLoopTimer = null;
      }
      this.killChild();
      const res = await this.mountCapture();
      if (!res.ok) this.emit('error', res.error || 'Remount failed');
    } finally {
      this.remounting = false;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let shared: LinuxLoopbackStream | null = null;

export function getLinuxLoopbackStream(): LinuxLoopbackStream {
  if (!shared) shared = new LinuxLoopbackStream();
  return shared;
}

/** One-shot capture for Settings test / Chat 🔊 — prefers working tools. */
export async function captureLinuxMonitorOnce(
  durationMs = 5_000,
  device?: string,
): Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string }> {
  const list = await listLinuxAudioDevices();
  let monitor = resolveLinuxMonitor(device, list);
  if (!monitor || monitor === '@DEFAULT_MONITOR@') {
    monitor =
      list.preferredMonitorId !== '@DEFAULT_MONITOR@'
        ? list.preferredMonitorId
        : list.monitors.find((m) => m.id.endsWith('.monitor'))?.id || '';
  }
  if (!monitor) {
    return { ok: false, error: 'No sink monitor found' };
  }

  const tmp = path.join(os.tmpdir(), `osmos-once-${Date.now()}.wav`);
  const durationSec = Math.max(1, Math.round(durationMs / 1000));

  const ffmpeg = resolveFfmpeg();
  if (ffmpeg) {
    const ok = await runTimed(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'pulse',
        '-i',
        monitor,
        '-t',
        String(durationSec),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-y',
        tmp,
      ],
      tmp,
      durationMs + 2500,
    );
    if (ok) return readWav(tmp);
  }

  const pw = resolveCaptureTool('pw-record');
  if (pw) {
    const ok = await runPwRecordFile(pw, monitor, tmp, durationMs);
    if (ok) return readWav(tmp);
  }

  return {
    ok: false,
    error: `System audio failed (monitor: ${monitor}). Need ffmpeg (pulse) or pw-record. Play sound on speakers and retry.`,
  };
}

function readWav(tmp: string): { ok: boolean; base64?: string; mimeType?: string; error?: string } {
  try {
    const base64 = fs.readFileSync(tmp).toString('base64');
    fs.unlinkSync(tmp);
    return { ok: true, base64, mimeType: 'audio/wav' };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: 'Failed to read captured audio' };
  }
}

function runTimed(bin: string, args: string[], tmp: string, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, waitMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(fs.existsSync(tmp) && fs.statSync(tmp).size > 400);
      } catch {
        resolve(false);
      }
    });
  });
}

function runPwRecordFile(bin: string, monitor: string, tmp: string, durationMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        bin,
        ['--rate=16000', '--channels=1', '--format=s16', `--target=${monitor}`, tmp],
        { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true },
      );
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          resolve(ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 400);
        } catch {
          resolve(false);
        }
      }, 150);
    };
    const timer = setTimeout(() => finish(true), durationMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish(true);
    });
  });
}
