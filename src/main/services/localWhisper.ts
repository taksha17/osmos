/**
 * Local Whisper STT via a system Node worker.
 * Transformers.js breaks in the Electron renderer (registerBackend / ORT).
 * Plain Node on PATH works; Electron's own Node crashes on GLib when loading ORT.
 *
 * Uses a persistent `--serve` worker so continuous chunks reuse a warm model.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import type { TranscribeRequest, TranscribeResponse } from '../../shared/types.js';
import readline from 'node:readline';

function projectRoot(): string {
  if (app.isPackaged) return app.getAppPath();
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function resolveNodeBinary(): string {
  return (
    process.env.OSMOS_NODE_BINARY ||
    process.env.UNCON_NODE_BINARY ||
    process.env.npm_node_execpath ||
    process.env.NODE_BINARY ||
    'node'
  );
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
    const worker = path.join(root, 'scripts/whisper-worker.mjs');
    const nodeBin = resolveNodeBinary();
    const cacheDir = cacheDirPath();

    const child = spawn(nodeBin, [worker, '--serve', cacheDir], {
      cwd: root,
      env: {
        ...process.env,
        OSMOS_ROOT: root,
        UNCON_ROOT: root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    serveProc = child;

    let settled = false;
    const failStart = (err: string) => {
      if (settled) return;
      settled = true;
      killServe();
      reject(new Error(err));
    };

    child.on('error', (err) => {
      failStart(
        err.message.includes('ENOENT')
          ? 'Local Whisper needs the `node` binary on PATH (or set OSMOS_NODE_BINARY).'
          : err.message,
      );
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
  const worker = path.join(root, 'scripts/whisper-worker.mjs');
  const nodeBin = resolveNodeBinary();

  return new Promise((resolve) => {
    const child = spawn(nodeBin, [worker, audioPath, cacheDir], {
      cwd: root,
      env: {
        ...process.env,
        OSMOS_ROOT: root,
        UNCON_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
        error:
          err.message.includes('ENOENT')
            ? 'Local Whisper needs the `node` binary on PATH (or set OSMOS_NODE_BINARY).'
            : err.message,
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
