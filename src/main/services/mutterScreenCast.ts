/**
 * GNOME Mutter ScreenCast backend for background screen reading (Linux).
 *
 * Drives `src/python/screen_worker.py`, which uses `org.gnome.Mutter.ScreenCast`
 * (the compositor API the xdg-desktop-portal wraps) + a GStreamer `pipewiresrc`
 * pipeline to pull monitor frames with **no permission dialog and no screen
 * flash**. This is the preferred continuous screen-read path on GNOME Wayland,
 * where the portal shows a picker and `gnome-screenshot` flashes the screen.
 *
 * Emits base64 JPEG frames; the caller (screenLive.ts) OCRs them. Requires
 * system python3 + python3-gi + GStreamer (default on Ubuntu GNOME); nothing is
 * bundled, so we probe before offering this backend.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { findOnPath, safeSpawnCwd } from './resolveBin.js';
import { cleanSpawnEnv } from './screenCapture.js';

function isFile(p: string): boolean {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveWorker(): string | null {
  const roots: string[] = [];
  try {
    if (app.isPackaged) {
      roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
      roots.push(process.resourcesPath);
    } else {
      roots.push(app.getAppPath());
      roots.push(process.cwd());
      roots.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    }
  } catch {
    roots.push(process.cwd());
  }
  for (const r of roots) {
    const p = path.join(r, 'src', 'python', 'screen_worker.py');
    if (isFile(p)) return p;
  }
  return null;
}

function resolvePython(): string | null {
  const fromEnv = [process.env.OSMOS_PYTHON_BINARY, process.env.PYTHON_BINARY, process.env.PYTHON];
  for (const c of fromEnv) if (c && isFile(c)) return c;
  return findOnPath('python3') || findOnPath('python');
}

let capableCache: { ok: boolean; reason?: string; at?: number } | undefined;

/**
 * Best-effort check that the no-permission Mutter path can run here. Spawns the
 * worker in `probe` mode (imports + live Mutter D-Bus name + pipewiresrc
 * plugin). Success is cached; failure is retried after a few seconds so a
 * one-off D-Bus miss doesn't permanently fall back to the share dialog.
 */
export function probeMutterScreenCast(): { ok: boolean; reason?: string } {
  if (capableCache?.ok) return capableCache;
  if (capableCache && Date.now() - (capableCache.at || 0) < 4000) return capableCache;
  if (process.platform !== 'linux') {
    capableCache = { ok: false, reason: 'Mutter ScreenCast is Linux/GNOME-only', at: Date.now() };
    return capableCache;
  }
  const py = resolvePython();
  const worker = resolveWorker();
  if (!py) {
    capableCache = { ok: false, reason: 'python3 not found (needed for Mutter ScreenCast)', at: Date.now() };
    return capableCache;
  }
  if (!worker) {
    capableCache = { ok: false, reason: 'screen_worker.py not found', at: Date.now() };
    return capableCache;
  }
  try {
    const out = execFileSync(py, [worker, 'probe'], {
      timeout: 6000,
      windowsHide: true,
      cwd: safeSpawnCwd(path.dirname(worker)),
      env: cleanSpawnEnv(),
    })
      .toString()
      .trim();
    const line = out.split('\n').filter(Boolean).pop() || '{}';
    const res = JSON.parse(line) as { ok?: boolean; error?: string };
    capableCache = res.ok
      ? { ok: true, at: Date.now() }
      : { ok: false, reason: res.error || 'probe failed', at: Date.now() };
  } catch (e) {
    capableCache = { ok: false, reason: e instanceof Error ? e.message : String(e), at: Date.now() };
  }
  return capableCache;
}

export type MutterFrame = { dataUrl: string; at: number };

/**
 * Long-lived Mutter ScreenCast capture. `frame` events carry a JPEG data URL;
 * `error` carries a message and implies the backend stopped.
 */
export class MutterScreenCastBackend extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private running = false;
  lastFrame: MutterFrame | null = null;

  get isRunning() {
    return this.running;
  }

  async start(intervalMs = 2000, width = 1440): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true };
    const py = resolvePython();
    const worker = resolveWorker();
    if (!py || !worker) return { ok: false, error: 'Mutter ScreenCast worker not available' };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(py, [worker], {
          cwd: safeSpawnCwd(path.dirname(worker)),
          env: cleanSpawnEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      this.proc = child;
      this.running = true;

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rl = rl;
      rl.on('line', (line: string) => {
        const t = line.trim();
        if (!t) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(t);
        } catch {
          return;
        }
        if (msg.ready === true) {
          try {
            child.stdin.write(JSON.stringify({ command: 'start', intervalMs, width }) + '\n');
          } catch {
            /* ignore */
          }
          return;
        }
        if (typeof msg.frame === 'string') {
          const frame: MutterFrame = {
            dataUrl: `data:image/jpeg;base64,${msg.frame}`,
            at: typeof msg.at === 'number' ? msg.at : Date.now(),
          };
          this.lastFrame = frame;
          finish({ ok: true });
          this.emit('frame', frame);
          return;
        }
        if (typeof msg.status === 'string') {
          console.log('[mutter-screencast]', msg.status);
          // Pipeline is live — don't wait for the first (large) JPEG to unstick IPC.
          finish({ ok: true });
          return;
        }
        if (typeof msg.error === 'string') {
          this.emit('error', msg.error);
          finish({ ok: false, error: msg.error });
          void this.stop();
        }
      });

      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        // pipewiresrc prints a harmless cross-thread warning on teardown.
        if (!/wrong context/.test(s)) console.warn('[mutter-screencast] stderr:', s.trim());
      });

      child.on('error', (err) => {
        this.running = false;
        this.emit('error', err.message);
        finish({ ok: false, error: err.message });
      });

      child.on('close', () => {
        this.running = false;
        this.rl?.close();
        this.rl = null;
        this.proc = null;
        finish({ ok: false, error: 'Mutter ScreenCast worker exited before first frame' });
      });

      // If no frame arrives quickly, the compositor may have refused — report so
      // the caller can fall back rather than hang.
      setTimeout(() => {
        if (!settled) {
          void this.stop();
          finish({ ok: false, error: 'Mutter ScreenCast produced no frames' });
        }
      }, 8000);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    const child = this.proc;
    this.proc = null;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        /* ignore */
      }
      this.rl = null;
    }
    if (child) {
      try {
        child.stdin.write(JSON.stringify({ command: 'quit' }) + '\n');
      } catch {
        /* ignore */
      }
      // Give it a moment to tear the PipeWire stream down cleanly, then kill.
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 500);
    }
  }
}
