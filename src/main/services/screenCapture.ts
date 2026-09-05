/**
 * Full-screen capture for OCR.
 *
 * On Linux Wayland, Electron desktopCapturer triggers the xdg-desktop-portal
 * screen-share picker. Calling it in a loop steals the share session from Zoom/Meet
 * and pops the dialog forever — never do that.
 *
 * Prefer CLI / OS tools that write a file without an interactive picker. Use
 * desktopCapturer only as a last resort for on-demand (button/hotkey) captures,
 * and never when `loopSafe: true`.
 */

import { desktopCapturer, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CaptureResult } from '../../shared/types.js';
import { findOnPath, safeSpawnCwd } from './resolveBin.js';

export type CaptureScreenOptions = {
  /** Refuse desktopCapturer / portal paths — required for continuous screen OCR. */
  loopSafe?: boolean;
};

/**
 * Strip VS Code Snap's library/module overrides — child processes inherit a
 * polluted glibc/gtk/gio module path that kills system binaries like
 * `gnome-screenshot` (`undefined symbol: __libc_pthread_init`).
 */
export function cleanSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const SNAP_VARS = [
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
    'GIO_MODULE_DIR',
    'GTK_PATH',
    'GTK_IM_MODULE_FILE',
    'GDK_PIXBUF_MODULE_FILE',
    'GDK_PIXBUF_MODULEDIR',
    'GSETTINGS_SCHEMA_DIR',
    'GTK_EXE_PREFIX',
    'XOAUTH_TOKEN',
    'SNAP_LIBRARY_PATH',
  ];
  for (const k of SNAP_VARS) delete env[k];
  return env;
}

async function tryCliScreenshot(command: string, args: string[], tmp: string): Promise<boolean> {
  const bin = findOnPath(command);
  if (!bin) {
    console.log(`[screenCapture] ${command}: not on PATH`);
    return false;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: safeSpawnCwd(),
        windowsHide: true,
        env: cleanSpawnEnv(),
      });
    } catch {
      resolve(false);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      console.log(`[screenCapture] ${command}: timeout`);
      resolve(false);
    }, 8000);
    child.on('error', (err) => {
      clearTimeout(timer);
      console.log(`[screenCapture] ${command}: spawn error:`, err.message);
      resolve(false);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      // gnome-screenshot sometimes writes the file just before/at close —
      // a brief poll avoids racing the write.
      let sz = 0;
      for (let i = 0; i < 15; i++) {
        try {
          sz = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
        } catch {
          sz = 0;
        }
        if (sz > 800) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const ok = code === 0 && sz > 800;
      console.log(
        `[screenCapture] ${command}: exit=${code} ok=${ok} size=${sz}${stderr.trim() ? ` stderr=${stderr.trim().slice(0, 400)}` : ''}`,
      );
      resolve(ok);
    });
  });
}

async function readPngDataUrl(tmp: string): Promise<CaptureResult> {
  try {
    const buffer = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, cancelled: false };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { dataUrl: '', cancelled: true };
  }
}

/** Windows GDI primary-screen grab — no portal; safe to poll. */
async function captureWindowsPrimary(tmp: string): Promise<CaptureResult | null> {
  if (process.platform !== 'win32') return null;
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
$bmp.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose();
$bmp.Dispose();
`;
  if (await tryCliScreenshot('powershell', ['-NoProfile', '-Command', psScript], tmp)) {
    return readPngDataUrl(tmp);
  }
  return null;
}

/** macOS silent full-screen — no interactive UI. */
async function captureMacPrimary(tmp: string): Promise<CaptureResult | null> {
  if (process.platform !== 'darwin') return null;
  if (await tryCliScreenshot('screencapture', ['-x', tmp], tmp)) {
    return readPngDataUrl(tmp);
  }
  return null;
}

async function captureViaDesktopCapturer(): Promise<CaptureResult> {
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      },
    });
    const primaryId = String(display.id);
    const source =
      sources.find((s) => s.display_id === primaryId) ||
      sources.find((s) => /entire screen|screen 1|display 1/i.test(s.name)) ||
      sources[0];
    if (!source?.thumbnail || source.thumbnail.isEmpty()) {
      return { dataUrl: '', cancelled: true };
    }
    return { dataUrl: source.thumbnail.toDataURL(), cancelled: false };
  } catch {
    return { dataUrl: '', cancelled: true };
  }
}

function isWaylandSession(): boolean {
  return (
    (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}

function isGnomeDesktop(): boolean {
  return /gnome/i.test(process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '');
}

/**
 * Whether a capture tool can be polled every few seconds WITHOUT the user
 * noticing. Rules (verified on GNOME 46 / Ubuntu 24.04):
 *   - `gnome-screenshot` and the xdg Screenshot portal play GNOME Shell's white
 *     shutter flash on EVERY shot (hard-coded, no flag). Fine for 📷 one-shot,
 *     unusable in a loop.
 *   - `grim` (wlroots) and `scrot` (X11) are silent, but do not work on Mutter/
 *     GNOME Wayland at all.
 *   - `spectacle -b -n` (KDE) is silent.
 * On GNOME Wayland the silent continuous path is Mutter ScreenCast
 * (`mutterScreenCast.ts`), not gnome-screenshot and not the share picker.
 */
export function describeLoopSafeCapture(): { ok: boolean; reason?: string; tool?: string } {
  if (process.platform === 'win32') return { ok: true, tool: 'gdi' };
  if (process.platform === 'darwin') {
    return findOnPath('screencapture')
      ? { ok: true, tool: 'screencapture' }
      : { ok: false, reason: 'macOS screencapture not found' };
  }
  const wayland = isWaylandSession();
  if (findOnPath('spectacle')) return { ok: true, tool: 'spectacle' };
  if (findOnPath('grim') && wayland && !isGnomeDesktop()) return { ok: true, tool: 'grim' };
  if (findOnPath('scrot') && !wayland) return { ok: true, tool: 'scrot' };
  if (wayland && isGnomeDesktop()) {
    return {
      ok: false,
      reason:
        'GNOME Wayland cannot loop gnome-screenshot (it flashes). Live reading uses Mutter ScreenCast instead.',
    };
  }
  return {
    ok: false,
    reason:
      'No silent screenshot tool found (Windows GDI, macOS screencapture, grim on wlroots, scrot on X11, spectacle on KDE).',
  };
}

/** True when a non-portal, non-flashing capture path exists for continuous OCR. */
export function canLoopSafeScreenCapture(): boolean {
  return describeLoopSafeCapture().ok;
}

/**
 * Whether the main-process CLI loop (`screenLive.ts`) may run here. Same rule as
 * `describeLoopSafeCapture` — gnome-screenshot is intentionally excluded because
 * it flashes. Kept async for API compatibility.
 */
export async function hasSilentScreenshotTool(): Promise<boolean> {
  return describeLoopSafeCapture().ok;
}

/**
 * Silent full-screen capture. Does not open an interactive region picker.
 * With `loopSafe: true`, never falls back to desktopCapturer (Wayland portal).
 */
export async function capturePrimaryScreen(opts?: CaptureScreenOptions): Promise<CaptureResult> {
  const loopSafe = Boolean(opts?.loopSafe);
  const tmp = path.join(os.tmpdir(), `osmos-screen-${Date.now()}.png`);

  const win = await captureWindowsPrimary(tmp);
  if (win) return win;

  const mac = await captureMacPrimary(tmp);
  if (mac) return mac;

  // Non-interactive fullscreen tools (no region UI). Silent tools first; the
  // flashing gnome-screenshot only for one-shot (never when loopSafe).
  if (await tryCliScreenshot('spectacle', ['-f', '-b', '-n', '-o', tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('grim', [tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('scrot', [tmp], tmp)) return readPngDataUrl(tmp);
  if (!loopSafe && (await tryCliScreenshot('gnome-screenshot', ['-f', tmp], tmp))) {
    return readPngDataUrl(tmp);
  }

  if (loopSafe) {
    return {
      dataUrl: '',
      cancelled: true,
      error: describeLoopSafeCapture().reason || 'No silent capture tool for continuous screen reading.',
    };
  }

  // Last resort — can prompt on Wayland once per call. Never use in a poll loop.
  return captureViaDesktopCapturer();
}
