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

async function tryCliScreenshot(command: string, args: string[], tmp: string): Promise<boolean> {
  const bin = findOnPath(command);
  if (!bin) return false;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 8000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 800);
      } catch {
        resolve(false);
      }
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

/** True when a non-portal capture path exists for continuous OCR. */
export function canLoopSafeScreenCapture(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return Boolean(findOnPath('screencapture'));
  return Boolean(
    findOnPath('gnome-screenshot') ||
      findOnPath('spectacle') ||
      findOnPath('grim') ||
      findOnPath('scrot'),
  );
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

  // Non-interactive fullscreen tools (no region UI).
  if (await tryCliScreenshot('gnome-screenshot', ['-f', tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('spectacle', ['-f', '-b', '-n', '-o', tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('grim', [tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('scrot', [tmp], tmp)) return readPngDataUrl(tmp);

  if (loopSafe) {
    return {
      dataUrl: '',
      cancelled: true,
      error:
        'Continuous screen assist needs a non-portal capture tool (grim, gnome-screenshot, spectacle, or scrot on Linux).',
    };
  }

  // Last resort — can prompt on Wayland once per call. Never use in a poll loop.
  return captureViaDesktopCapturer();
}
