/**
 * Local Whisper STT via a system Node worker.
 * Transformers.js breaks in the Electron renderer (registerBackend / ORT).
 * Plain Node on PATH works; Electron's own Node crashes on GLib when loading ORT.
 *
 * Uses a persistent `--serve` worker so continuous chunks reuse a warm model.
 *
 * Packaged builds: worker + @xenova/transformers live under app.asar.unpacked
 * (external Node cannot read asar). Never use app.getAppPath() as spawn cwd —
 * that path is the asar *file* and causes spawn ENOTDIR.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import type { TranscribeRequest, TranscribeResponse } from '../../shared/types.js';
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

/** Unpacked app root for packaged builds (real directory). */
function unpackedRoot(): string {
  return path.join(process.resourcesPath, 'app.asar.unpacked');
}

function projectRoot(): string {
  if (app.isPackaged) {
    const unpacked = unpackedRoot();
    if (isDir(unpacked)) return unpacked;
    return process.resourcesPath;
  }
  // Bundled main lives at dist-electron/main/index.js → repo root is ../..
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function resolveWorkerScript(): string {
  if (app.isPackaged) {
    const candidates = [
      path.join(unpackedRoot(), 'scripts', 'whisper-worker.mjs'),
      path.join(process.resourcesPath, 'scripts', 'whisper-worker.mjs'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'whisper-worker.mjs'),
    ];
    for (const c of candidates) {
      if (isFile(c)) return c;
    }
    return candidates[0]!;
  }
  return path.join(projectRoot(), 'scripts', 'whisper-worker.mjs');
}

function resolveNodeBinary(): string {
  const fromEnv = [
    process.env.OSMOS_NODE_BINARY,
    process.env.UNCON_NODE_BINARY,
    process.env.NODE_BINARY,
    // Only trust npm's path when it is a real file (packaged apps often inherit junk).
    process.env.npm_node_execpath,
  ];
  for (const c of fromEnv) {
    if (c && isExecutableFile(c)) return c;
  }
  const onPath = findOnPath('node');
  if (onPath) return onPath;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function spawnErrorHint(err: NodeJS.ErrnoException, nodeBin: string, worker: string, cwd: string): string {
  const code = err.code || '';
  if (code === 'ENOTDIR') {
    return (
      `Local Whisper spawn ENOTDIR (cwd or binary is not a directory/file). ` +
      `node=${nodeBin} worker=${worker} cwd=${cwd}. ` +
      `If this is a packaged build, ensure scripts/whisper-worker.mjs is asar-unpacked.`
    );
  }
  if (code === 'ENOENT' || /ENOENT/i.test(err.message)) {
    return 'Local Whisper needs the `node` binary on PATH (or set OSMOS_NODE_BINARY).';
  }
  return err.message;
}

type Pending = {
  resolve: (v: { ok: boolean; text?: string; error?: string }) => void;
};

let serveProc: ChildProcessWithoutNullStreams | null = null;
let serveReady: Promise<void> | null = null;
let serveRl: readline.Interface | null = null;
const pending = new Map<string, Pending>();
let reqSeq = 0;

function cacheDirPath(): string {
  return path.join(app.getPath('userData'), 'whisper-cache');
}

function killServe() {
  if (serveRl) {
    try {
      serveRl.close();
    } catch {
      /* ignore */
    }
    serveRl = null;
  }
  if (serveProc) {
    try {
      serveProc.kill();
    } catch {
      /* ignore */
    }
    serveProc = null;
  }
  serveReady = null;
  for (const [, p] of pending) {
    p.resolve({ ok: false, error: 'Local Whisper worker stopped' });
  }
  pending.clear();
}

function ensureServe(): Promise<void> {
  if (serveReady) return serveReady;

  const starting: Promise<void> = new Promise<void>((resolve, reject) => {
    const root = projectRoot();
    const worker = resolveWorkerScript();
    const nodeBin = resolveNodeBinary();
    const cacheDir = cacheDirPath();
    const cwd = safeSpawnCwd(root);

    if (!isFile(worker)) {
      reject(
        new Error(
          `Local Whisper worker missing at ${worker}. ` +
            (app.isPackaged
              ? 'Repack with scripts/whisper-worker.mjs in asarUnpack.'
              : 'Check scripts/whisper-worker.mjs exists in the repo.'),
        ),
      );
      return;
    }

    let child;
    try {
      child = spawn(nodeBin, [worker, '--serve', cacheDir], {
        cwd,
        env: {
          ...process.env,
          OSMOS_ROOT: root,
          UNCON_ROOT: root,
          // Help system Node find unpacked deps next to the worker.
          NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      reject(new Error(spawnErrorHint(err, nodeBin, worker, cwd)));
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
      failStart(spawnErrorHint(err as NodeJS.ErrnoException, nodeBin, worker, cwd));
    });

    child.on('close', () => {
      killServe();
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    serveRl = rl;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { id?: string; ok?: boolean; ready?: boolean; text?: string; error?: string };
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
      waiter.resolve({
        ok: Boolean(msg.ok),
        text: msg.text,
        error: msg.error,
      });
    });

    child.stderr.on('data', () => {
      /* model download noise — ignore */
    });

    setTimeout(() => {
      if (!settled) failStart('Local Whisper worker timed out starting');
    }, 120_000);
  });

  serveReady = starting.catch((e: unknown) => {
    serveReady = null;
    throw e;
  });

  return serveReady;
}

async function runViaServe(audioPath: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  await ensureServe();
  if (!serveProc?.stdin) return { ok: false, error: 'Local Whisper worker not available' };

  const id = `w-${Date.now()}-${++reqSeq}`;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    try {
      serveProc!.stdin.write(JSON.stringify({ id, audioPath }) + '\n');
    } catch (e) {
      pending.delete(id);
      killServe();
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve({ ok: false, error: 'Local Whisper timed out' });
    }, 90_000);
  });
}

/** One-shot fallback if serve mode fails. */
function runOneShot(
  audioPath: string,
  cacheDir: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const root = projectRoot();
  const worker = resolveWorkerScript();
  const nodeBin = resolveNodeBinary();
  const cwd = safeSpawnCwd(root);

  return new Promise((resolve) => {
    if (!isFile(worker)) {
      resolve({ ok: false, error: `Local Whisper worker missing at ${worker}` });
      return;
    }

    let child;
    try {
      child = spawn(nodeBin, [worker, audioPath, cacheDir], {
        cwd,
        env: {
          ...process.env,
          OSMOS_ROOT: root,
          UNCON_ROOT: root,
          NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve({ ok: false, error: spawnErrorHint(err, nodeBin, worker, cwd) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        error: spawnErrorHint(err as NodeJS.ErrnoException, nodeBin, worker, cwd),
      });
    });

    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(line) as { ok: boolean; text?: string; error?: string };
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          error:
            `Local Whisper worker failed (exit ${code}). ${stderr.slice(-400) || line || 'No output'}`.trim(),
        });
      }
    });
  });
}

export async function transcribeLocalWhisper(
  req: TranscribeRequest,
): Promise<TranscribeResponse> {
  const bytes = Buffer.from(req.base64, 'base64');
  if (bytes.length < 400) {
    return { ok: false, error: 'Recording too short — speak, then click Stop.' };
  }

  const mime = (req.mimeType || '').toLowerCase();
  const ext = mime.includes('wav')
    ? 'wav'
    : mime.includes('mp3')
      ? 'mp3'
      : mime.includes('ogg')
        ? 'ogg'
        : 'webm';

  const tmpDir = app.getPath('temp');
  const audioPath = path.join(tmpDir, `osmos-stt-${Date.now()}-${process.pid}.${ext}`);
  const cacheDir = cacheDirPath();

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(audioPath, bytes);

    let result: { ok: boolean; text?: string; error?: string };
    try {
      result = await runViaServe(audioPath);
    } catch {
      killServe();
      result = await runOneShot(audioPath, cacheDir);
    }

    if (!result.ok) return { ok: false, error: result.error || 'Local Whisper failed' };
    const text = (result.text || '').trim();
    if (!text) return { ok: false, error: 'Local Whisper returned empty text.' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await fs.unlink(audioPath).catch(() => undefined);
  }
}

export function stopLocalWhisperWorker() {
  killServe();
}
