/**
 * Capture worker client — Architecture v2, §5.1.
 *
 * Main keeps backend *selection* (pactl / dshow / AVFoundation enumeration) and
 * hands the resolved ffmpeg input args to an isolated worker, which owns the
 * pipe, the chunk slicing and the RMS gate. The public surface mirrors the old
 * in-process streams (`start`/`stop` + `chunk`/`status`/`error` events) so
 * `src/main/index.ts` and the renderer stay unchanged.
 *
 * Fallback: if the worker cannot start (missing script, no runtime, ffmpeg
 * gone), callers keep using the legacy stream and the user sees one status
 * line instead of a silent failure.
 */

import { EventEmitter } from 'node:events';
import {
  listAudioDevices,
  listLinuxAudioDevices,
  resolveLinuxMicSource,
  resolveLinuxMonitor,
} from './audioDevices.js';
import { findOnPath, resolveFfmpeg, safeSpawnCwd } from './resolveBin.js';
import { listAvAudioInputs, listDshowAudioInputs } from '../platform/index.js';
import { WorkerSupervisor } from '../supervisor/workerSupervisor.js';
import { CAPTURE_WORKER_REL, resolveWorkerScript } from '../supervisor/workerPaths.js';
import { planWorkerCommand } from '../../shared/policy/workerRuntime.js';

export type CaptureChannel = 'mic' | 'loopback';

export type CaptureChunk = {
  ok: true;
  base64: string;
  mimeType: 'audio/wav';
  rms: number;
  silent: boolean;
  source: string;
  monitor?: string;
  backend: string;
};

export type CaptureStartResult = {
  ok: boolean;
  error?: string;
  source?: string;
  monitor?: string;
  backend?: string;
};

type ResolvedInput = {
  ok: boolean;
  error?: string;
  ffmpeg?: string;
  inputArgs?: string[];
  source?: string;
  backend?: string;
};

/** Kill switch for support: OSMOS_CAPTURE_WORKERS=0 restores the inline streams. */
export function captureWorkersEnabled(): boolean {
  return process.env.OSMOS_CAPTURE_WORKERS !== '0';
}

async function resolveInput(
  channel: CaptureChannel,
  device?: string,
): Promise<ResolvedInput> {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    return { ok: false, error: 'ffmpeg is required for continuous audio capture.' };
  }

  if (channel === 'loopback') {
    if (process.platform !== 'linux') {
      return { ok: false, error: 'Continuous loopback uses the Electron path on this OS.' };
    }
    const list = await listLinuxAudioDevices();
    if (!list) return { ok: false, error: 'System audio listing unavailable.' };
    const monitor = resolveLinuxMonitor(device || undefined, list);
    if (!monitor) return { ok: false, error: 'No sink monitor found for system audio.' };
    return {
      ok: true,
      ffmpeg,
      inputArgs: ['-f', 'pulse', '-i', monitor],
      source: monitor,
      backend: 'ffmpeg',
    };
  }

  if (process.platform === 'linux') {
    const list = await listAudioDevices();
    if (!list) return { ok: false, error: 'Microphone listing unavailable.' };
    const source = resolveLinuxMicSource(device || undefined, list);
    if (!source || source === 'default') {
      return { ok: false, error: 'No usable microphone found. Check Settings → Speech.' };
    }
    return { ok: true, ffmpeg, inputArgs: ['-f', 'pulse', '-i', source], source };
  }

  if (process.platform === 'darwin') {
    const devices = await listAvAudioInputs();
    if (!devices.length) {
      return { ok: false, error: 'No AVFoundation audio inputs found. Grant Microphone permission.' };
    }
    let index = devices[0]!.index;
    const wanted = (device || '').trim();
    if (wanted) {
      const byIndex = Number(wanted);
      if (!Number.isNaN(byIndex)) index = byIndex;
      else {
        const hit = devices.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase()));
        if (hit) index = hit.index;
      }
    }
    const chosen = devices.find((d) => d.index === index) ?? devices[0]!;
    return {
      ok: true,
      ffmpeg,
      inputArgs: ['-f', 'avfoundation', '-i', `:${chosen.index}`],
      source: chosen.name,
    };
  }

  if (process.platform === 'win32') {
    const names = await listDshowAudioInputs();
    if (!names.length) {
      return {
        ok: false,
        error:
          'No DirectShow microphones found. Check Windows Settings → Privacy → Microphone, then retry.',
      };
    }
    const wanted = (device || '').trim().toLowerCase();
    const pick =
      (wanted && names.find((n) => n.toLowerCase().includes(wanted))) ||
      names.find((n) => /microphone|mic\b/i.test(n)) ||
      names[0]!;
    return { ok: true, ffmpeg, inputArgs: ['-f', 'dshow', '-i', `audio=${pick}`], source: pick };
  }

  return { ok: false, error: `Continuous capture is not supported on ${process.platform}.` };
}

export class CaptureWorkerClient extends EventEmitter {
  private channel: CaptureChannel;
  private supervisor: WorkerSupervisor | null = null;
  private startCommand: Record<string, unknown> | null = null;
  private source = '';
  private backend = 'ffmpeg';
  private running = false;
  private lastError = '';
  private restarts = 0;

  constructor(channel: CaptureChannel) {
    super();
    this.channel = channel;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private get label(): string {
    return this.channel === 'mic' ? 'Mic capture' : 'System audio';
  }

  async start(opts: { device?: string; chunkMs?: number } = {}): Promise<CaptureStartResult> {
    await this.stop();

    const resolved = await resolveInput(this.channel, opts.device);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const script = resolveWorkerScript(CAPTURE_WORKER_REL);
    if (!script) {
      return {
        ok: false,
        error: 'Capture worker script is missing (expected src/workers/capture/capture-worker.mjs).',
      };
    }

    const launch = planWorkerCommand({
      isElectron: Boolean(process.versions.electron),
      execPath: process.execPath,
      systemNode: findOnPath('node'),
      preferBundled: process.env.OSMOS_WORKER_RUNTIME !== 'system',
    });
    if (!launch) return { ok: false, error: 'No Node runtime available to launch the capture worker.' };

    this.source = resolved.source ?? '';
    this.backend = resolved.backend ?? 'ffmpeg';
    this.startCommand = {
      cmd: 'start',
      channel: this.channel,
      ffmpeg: resolved.ffmpeg,
      inputArgs: resolved.inputArgs,
      chunkMs: opts.chunkMs,
      source: this.source,
      backend: this.backend,
      overlapMs: this.channel === 'mic' ? 250 : 0,
      cwd: safeSpawnCwd(),
    };

    const supervisor = new WorkerSupervisor({
      id: `capture:${this.channel}`,
      label: this.label,
      command: launch.command,
      args: [script],
      cwd: safeSpawnCwd(),
      env: launch.env,
      // Audio arrives every ~20 ms; a full second of silence is already long.
      stallMs: 4_000,
      readyTimeoutMs: 20_000,
    });

    supervisor.on('message', (message) => this.onMessage(message));
    supervisor.on('status', (event) => {
      this.restarts = event.restarts;
      if (event.state === 'degraded' || event.state === 'crashed') {
        this.lastError = event.detail ?? this.lastError;
      }
      if (typeof event.detail === 'string' && event.detail) {
        this.emit('status', event.detail);
      }
    });

    this.supervisor = supervisor;
    this.running = true;
    supervisor.start();

    return { ok: true, source: this.source, monitor: this.source, backend: this.backend };
  }

  private onMessage(message: Record<string, unknown> & { type?: string }) {
    if (message.type === 'ready') {
      // First launch and every supervised restart both resume the same input.
      if (this.startCommand && this.supervisor) this.supervisor.send(this.startCommand);
      this.emit('status', `${this.label} worker ready`);
      return;
    }

    if (message.type === 'chunk') {
      const chunk: CaptureChunk = {
        ok: true,
        base64: String(message.base64 ?? ''),
        mimeType: 'audio/wav',
        rms: Number(message.rms ?? 0),
        silent: Boolean(message.silent),
        source: String(message.source ?? this.source),
        monitor: this.channel === 'loopback' ? String(message.source ?? this.source) : undefined,
        backend: String(message.backend ?? this.backend),
      };
      this.emit('chunk', chunk);
      return;
    }

    if (message.type === 'error') {
      this.lastError = String(message.error ?? 'capture worker error');
      this.emit('error', this.lastError);
      return;
    }

    if (message.type === 'exit') {
      const stderr = String(message.stderrTail ?? '');
      this.emit(
        'status',
        `${this.label} backend exited (code ${String(message.code)})${
          stderr ? ` · ${stderr.slice(0, 200)}` : ''
        }`,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const supervisor = this.supervisor;
    this.supervisor = null;
    this.startCommand = null;
    if (supervisor) await supervisor.stop();
  }

  /** Shape-compatible with the old `MicStream.getLastError()` diagnostics panel. */
  getLastError() {
    return {
      deathCount: this.restarts,
      lastSpawnAt: null as number | null,
      lastDeathAt: null as number | null,
      lastSpawnArgs: [] as string[],
      lastStderr: this.lastError,
      lastExitCode: null as number | null,
      lastErrorMessage: this.lastError,
    };
  }
}

const clients = new Map<CaptureChannel, CaptureWorkerClient>();

export function getCaptureWorkerClient(channel: CaptureChannel): CaptureWorkerClient {
  let client = clients.get(channel);
  if (!client) {
    client = new CaptureWorkerClient(channel);
    clients.set(channel, client);
  }
  return client;
}

/** Stop both channels — used on app shutdown. */
export async function stopCaptureWorkers(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.stop().catch(() => undefined)));
}
