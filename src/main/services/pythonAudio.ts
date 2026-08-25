/**
 * Python Audio Worker Service
 * 
 * Manages a standalone Python process for cross-platform audio capture.
 * Follows the same pattern as localWhisper.ts for process management.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import type { AudioDeviceInfo, SystemAudioResponse, SystemAudioRequest } from '../../shared/types.js';
import readline from 'node:readline';
import { findOnPath, isExecutableFile, safeSpawnCwd } from './resolveBin.js';

function isDir(p: string): boolean {
  try {
    return fsSync.existsSync(p) && fsSync.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fsSync.existsSync(p) && fsSync.statSync(p).isFile();
  } catch {
    return false;
  }
}

function unpackedRoot(): string {
  return path.join(process.resourcesPath, 'app.asar.unpacked');
}

function projectRoot(): string {
  if (app.isPackaged) {
    const unpacked = unpackedRoot();
    if (isDir(unpacked)) return unpacked;
    return process.resourcesPath;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function resolvePythonWorker(): string {
  if (app.isPackaged) {
    const candidates = [
      path.join(unpackedRoot(), 'src', 'python', 'audio_worker.py'),
      path.join(process.resourcesPath, 'src', 'python', 'audio_worker.py'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'python', 'audio_worker.py'),
    ];
    for (const c of candidates) {
      if (isFile(c)) return c;
    }
    return candidates[0]!;
  }
  return path.join(projectRoot(), 'src', 'python', 'audio_worker.py');
}

/** Standalone frozen worker (PyInstaller) — preferred; needs no Python on user machines. */
export function resolveFrozenWorker(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const name = `osmos-audio-worker${ext}`;
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'audio-worker', name),
        path.join(unpackedRoot(), 'binaries', 'audio-worker', name),
      ]
    : [path.join(projectRoot(), 'binaries', 'audio-worker', name)];
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

function resolvePythonBinary(): string {
  const fromEnv = [
    process.env.OSMOS_PYTHON_BINARY,
    process.env.PYTHON_BINARY,
    process.env.PYTHON,
  ];
  for (const c of fromEnv) {
    if (c && isExecutableFile(c)) return c;
  }
  const onPath = findOnPath('python3') || findOnPath('python');
  if (onPath) return onPath;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function spawnErrorHint(err: NodeJS.ErrnoException, pyBin: string, worker: string, cwd: string): string {
  const code = err.code || '';
  if (code === 'ENOTDIR') {
    return (
      `Python audio worker spawn ENOTDIR (cwd or binary is not a directory/file). ` +
      `python=${pyBin} worker=${worker} cwd=${cwd}. ` +
      `If this is a packaged build, ensure src/python/audio_worker.py is asar-unpacked.`
    );
  }
  if (code === 'ENOENT' || /ENOENT/i.test(err.message)) {
    return 'Python audio worker needs the `python3` binary on PATH (or set OSMOS_PYTHON_BINARY).';
  }
  return err.message;
}

type Pending = {
  resolve: (v: { ok: boolean; [key: string]: unknown }) => void;
};

let serveProc: ChildProcessWithoutNullStreams | null = null;
let serveReady: Promise<void> | null = null;
let serveRl: readline.Interface | null = null;
const pending = new Map<string, Pending>();
let reqSeq = 0;

function killServe() {
  if (serveRl) {
    try {
      serveRl.close();
    } catch { }
    serveRl = null;
  }
  if (serveProc) {
    try {
      serveProc.kill();
    } catch { }
    serveProc = null;
  }
  serveReady = null;
  for (const [, p] of pending) {
    p.resolve({ ok: false, error: 'Python audio worker stopped' });
  }
  pending.clear();
}

function ensureServe(): Promise<void> {
  if (serveReady) return serveReady;

  const starting: Promise<void> = new Promise<void>((resolve, reject) => {
    const root = projectRoot();
    const frozen = resolveFrozenWorker();
    const worker = resolvePythonWorker();
    // Prefer the standalone frozen binary — zero user-side Python/deps.
    const pyBin = frozen ? null : resolvePythonBinary();
    const cwd = safeSpawnCwd(root);

    if (!frozen && !isFile(worker)) {
      reject(
        new Error(
          `Python audio worker missing at ${worker}. ` +
            (app.isPackaged
              ? 'Repack with src/python/audio_worker.py in asarUnpack.'
              : 'Check src/python/audio_worker.py exists in the repo.'),
        ),
      );
      return;
    }

    let child;
    try {
      if (frozen) {
        child = spawn(frozen, [], {
          cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        const workerDir = path.dirname(worker);
        child = spawn(pyBin!, [worker], {
          cwd: isDir(workerDir) ? workerDir : cwd,
          env: {
            ...process.env,
            PYTHONPATH: [workerDir, path.join(root, 'src', 'python'), process.env.PYTHONPATH]
              .filter(Boolean)
              .join(path.delimiter),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      reject(new Error(spawnErrorHint(err, pyBin || 'frozen', frozen || worker, cwd)));
      return;
    }
    serveProc = child;

    let settled = false;
    const failStart = (err: string) => {
      if (settled) return;
      settled = true;
      killServe();
      reject(new Error(err));
    };

    child.on('error', (err) => {
      failStart(spawnErrorHint(err as NodeJS.ErrnoException, pyBin || 'frozen', frozen || worker, cwd));
    });

    child.on('close', () => {
      killServe();
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    serveRl = rl;

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.ready && !settled) {
        settled = true;
        resolve();
        return;
      }
      const id = msg.id || '';
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.resolve(msg);
    });

    child.stderr.on('data', (data: Buffer) => {
      console.warn('[python-audio] stderr:', data.toString().trim());
    });

    setTimeout(() => {
      if (!settled) failStart('Python audio worker timed out starting');
    }, 15_000);
  });

  serveReady = starting.catch((e: unknown) => {
    serveReady = null;
    throw e;
  });

  return serveReady;
}

async function sendCommand(
  command: object,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  await ensureServe();
  if (!serveProc?.stdin) return { ok: false, error: 'Python audio worker not available' };

  const id = `pa-${Date.now()}-${++reqSeq}`;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    try {
      serveProc!.stdin.write(JSON.stringify({ id, ...command }) + '\n');
    } catch (e) {
      pending.delete(id);
      killServe();
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve({ ok: false, error: 'Python audio worker timed out' });
    }, 30_000);
  });
}

export async function listAudioDevicesPython(): Promise<{
  ok: boolean;
  inputs?: AudioDeviceInfo[];
  outputs?: AudioDeviceInfo[];
  preferredInputId?: string;
  preferredOutputId?: string;
  error?: string;
}> {
  return sendCommand({ command: 'list_devices' }) as Promise<{
    ok: boolean;
    inputs?: AudioDeviceInfo[];
    outputs?: AudioDeviceInfo[];
    preferredInputId?: string;
    preferredOutputId?: string;
    error?: string;
  }>;
}

export async function startAudioCapturePython(
  config: {
    sampleRate?: number;
    channels?: number;
    deviceId?: string;
    audioSource?: 'system' | 'mic' | 'both';
  },
): Promise<{ ok: boolean; error?: string; monitor?: string }> {
  return sendCommand({
    command: 'start_capture',
    config: {
      sample_rate: config.sampleRate || 16000,
      channels: config.channels || 1,
      device_id: config.deviceId,
      audio_source: config.audioSource || 'system',
    },
  }) as Promise<{ ok: boolean; error?: string; monitor?: string }>;
}

export async function stopAudioCapturePython(): Promise<{ ok: boolean; error?: string }> {
  return sendCommand({ command: 'stop_capture' }) as Promise<{ ok: boolean; error?: string }>;
}

export async function getAudioDeviceInfoPython(deviceId: string): Promise<{
  ok: boolean;
  device_info?: Record<string, unknown>;
  error?: string;
}> {
  return sendCommand({ command: 'get_device_info', device_id: deviceId }) as Promise<{
    ok: boolean;
    device_info?: Record<string, unknown>;
    error?: string;
  }>;
}

export function stopPythonAudioWorker() {
  killServe();
}