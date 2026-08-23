/**
 * Full-screen capture for OCR.
 *
 * On Linux Wayland, Electron desktopCapturer triggers the xdg-desktop-portal
 * screen-share picker. Calling it in a loop steals the share session from Zoom/Meet
 * and pops the dialog forever — never do that.
 *
 * Prefer CLI tools that write a file without an interactive picker. Use
 * desktopCapturer only as a last resort for on-demand (button/hotkey) captures.
 */

import { desktopCapturer, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CaptureResult } from '../../shared/types.js';
import { findOnPath, safeSpawnCwd } from './resolveBin.js';

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

/**
 * Silent full-screen capture. Does not open an interactive region picker.
 * May still show a one-shot portal on some Wayland sessions if only Electron
 * capture is available — callers must not invoke this in a tight loop.
 */
export async function capturePrimaryScreen(): Promise<CaptureResult> {
  const tmp = path.join(os.tmpdir(), `osmos-screen-${Date.now()}.png`);

  // Non-interactive fullscreen tools (no region UI).
  if (await tryCliScreenshot('gnome-screenshot', ['-f', tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('spectacle', ['-f', '-b', '-n', '-o', tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('grim', [tmp], tmp)) return readPngDataUrl(tmp);
  if (await tryCliScreenshot('scrot', [tmp], tmp)) return readPngDataUrl(tmp);

  // Last resort — can prompt on Wayland once per call.
  return captureViaDesktopCapturer();
}
