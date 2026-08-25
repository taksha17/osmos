/**
 * Main-process microphone stream for Smart mode — cross-platform.
 *
 * Backends (all emit s16le 16kHz mono PCM on stdout, sliced into WAV chunks):
 * - Linux:   ffmpeg -f pulse -i <source-id>          (device via audioDevices resolver)
 * - macOS:   ffmpeg -f avfoundation -i ":<index>"    (AVFoundation audio index)
 * - Windows: ffmpeg -f dshow -i audio="<name>"       (DirectShow device name)
 *
 * Living in main makes capture immune to renderer lifecycle churn. The stream
 * self-heals: unexpected child death triggers respawn with backoff, and a
 * renderer-side stall watchdog force-rebuilds the pipe if chunks stop flowing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { listAudioDevices, resolveLinuxMicSource } from './audioDevices.js';
import { resolveFfmpeg, safeSpawnCwd } from './resolveBin.js';
import { listAvAudioInputs, listDshowAudioInputs } from '../platform/index.js';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const SILENCE_RMS = 0.006;

export type MicStreamChunk = {
  ok: true;
  base64: string;
  mimeType: 'audio/wav';
  rms: number;
  silent: boolean;
  source: string;
};

type MicRequest = { device?: string; chunkMs?: number };

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

export class MicStream extends EventEmitter {
  private child: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private bytesWanted = 0;
  private chunkMs = 6000;
  private source = '';
  private running = false;
  private respawns = 0;
  /** Tail of previous chunk (0.25s) so words split at boundaries keep context. */
  private tail: Buffer = Buffer.alloc(0);
  private static OVERLAP_BYTES = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * 0.25);
  /** Resolved per-platform spawn target + args prefix. */
  private backendArgs: string[] | null = null;

  get isRunning() {
    return this.running;
  }

  async start(
    req: MicRequest = {},
  ): Promise<{ ok: boolean; error?: string; source?: string }> {
    if (this.running) await this.stop();
    this.chunkMs = Math.max(2000, Math.min(15_000, req.chunkMs || 6000));
    this.bytesWanted = Math.floor((SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * this.chunkMs) / 1000);

    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) return { ok: false, error: 'ffmpeg is required for continuous mic capture.' };

    const resolved = await this.resolveBackend(req.device || undefined);
    if (!resolved.ok) return resolved;
    this.source = resolved.source!;

    this.tail = Buffer.alloc(0);
    this.respawns = 0;
    this.spawnFfmpeg(ffmpeg);
    return { ok: true, source: this.source };
  }

  /** Resolve platform-specific ffmpeg input args; sets this.backendArgs. */
  private async resolveBackend(device?: string): Promise<{ ok: boolean; error?: string; source?: string }> {
    // Reuse cached args when only chunk size changed (respawn path).
    if (this.backendArgs && !device) return { ok: true, source: this.source };

    if (process.platform === 'linux') {
      const list = await listAudioDevices();
      if (!list) return { ok: false, error: 'Microphone listing unavailable.' };
      const source = resolveLinuxMicSource(device || undefined, list);
      if (!source || source === 'default') {
        return { ok: false, error: 'No usable microphone found. Check Settings → Speech.' };
      }
      this.backendArgs = ['-f', 'pulse', '-i', source];
      return { ok: true, source };
    }

    if (process.platform === 'darwin') {
      const devices: Array<{ index: number; name: string }> = await listAvAudioInputs();
      if (!devices.length) {
        return { ok: false, error: 'No AVFoundation audio inputs found. Grant Microphone permission.' };
      }
      let index = devices[0]!.index;
      const wanted = (device || '').trim();
      if (wanted) {
        const byIdx = Number(wanted);
        if (!Number.isNaN(byIdx)) index = byIdx;
        else {
          const hit = devices.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase()));
          if (hit) index = hit.index;
        }
      }
      const chosen = devices.find((d) => d.index === index) ?? devices[0]!;
      // ":index" with empty video component selects audio-only input.
      this.backendArgs = ['-f', 'avfoundation', '-i', `:${chosen.index}`];
      return { ok: true, source: chosen.name };
    }

    if (process.platform === 'win32') {
      const names: string[] = await listDshowAudioInputs();
      if (!names.length) {
        return {
          ok: false,
          error:
            'No DirectShow microphones found. Check: ① Windows Settings → Privacy & security → Microphone → allow desktop apps; ② a mic is enabled in Sound settings; then toggle ⚡ Smart again.',
        };
      }
      const wanted = (device || '').trim().toLowerCase();
      const pick =
        (wanted && names.find((n) => n.toLowerCase().includes(wanted))) ||
        names.find((n) => /microphone|mic\b/i.test(n)) ||
        names[0]!;
      this.backendArgs = ['-f', 'dshow', '-i', `audio=${pick}`];
      return { ok: true, source: pick };
    }

    return { ok: false, error: `Continuous mic streaming is not supported on ${process.platform}.` };
  }

  /** Spawn (or respawn) ffmpeg with full event wiring and self-heal. */
  private spawnFfmpeg(bin: string): void {
    this.killChild();
    this.chunks = [];
    if (!this.backendArgs) {
      this.emit('error', 'Mic backend not resolved');
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(
        bin,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          ...this.backendArgs,
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
      this.emit('error', e instanceof Error ? e.message : String(e));
      return;
    }
    this.child = child;
    this.running = true;

    let errBuf = '';
    child.stdout?.on('data', (buf: Buffer) => {
      if (!this.running) return;
      this.respawns = 0; // healthy data flow resets backoff
      // Carry previous chunk's tail so boundary-split words keep context.
      const joined = this.tail.length ? Buffer.concat([this.tail, buf]) : buf;
      if (joined.length > MicStream.OVERLAP_BYTES) {
        this.tail = Buffer.from(joined.subarray(joined.length - MicStream.OVERLAP_BYTES));
      }
      this.chunks.push(joined);
      let total = this.chunks.reduce((n, b) => n + b.length, 0);
      while (total >= this.bytesWanted) {
        const all = Buffer.concat(this.chunks);
        const slice = all.subarray(0, this.bytesWanted);
        const rest = all.subarray(this.bytesWanted);
        this.chunks = rest.length ? [rest] : [];
        total = rest.length;
        this.emitChunk(slice);
      }
    });

    child.stderr?.on('data', (b: Buffer) => {
      errBuf += b.toString('utf8');
      if (errBuf.length > 500) errBuf = errBuf.slice(-500);
    });

    child.on('error', (err) => {
      if (!this.running) return;
      this.emit('error', err.message || 'mic ffmpeg failed');
    });

    child.on('close', (code) => {
      if (!this.running) return;
      // Self-heal: respawn with escalating backoff instead of going silent.
      if (this.respawns < 5) {
        this.respawns += 1;
        this.emit('status', `🎙 reconnecting (${this.respawns}/5)…`);
        setTimeout(() => {
          if (!this.running) return;
          this.spawnFfmpeg(bin);
        }, 1000 * this.respawns);
        return;
      }
      this.running = false;
      this.emit(
        'error',
        `Mic capture stopped (code ${code})${errBuf.trim() ? `: ${errBuf.trim().slice(0, 160)}` : ''}`,
      );
    });
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

  async stop(): Promise<void> {
    this.running = false;
    this.killChild();
    this.chunks = [];
    this.tail = Buffer.alloc(0);
    // Keep backendArgs so respawns skip re-enumeration.
  }

  private emitChunk(pcm: Buffer) {
    const rms = pcmRms(pcm);
    const wav = wrapPcmS16leAsWav(pcm, SAMPLE_RATE, CHANNELS);
    const chunk: MicStreamChunk = {
      ok: true,
      base64: wav.toString('base64'),
      mimeType: 'audio/wav',
      rms,
      silent: rms < SILENCE_RMS,
      source: this.source,
    };
    this.emit('chunk', chunk);
  }
}

let shared: MicStream | null = null;

export function getMicStream(): MicStream {
  if (!shared) shared = new MicStream();
  return shared;
}
