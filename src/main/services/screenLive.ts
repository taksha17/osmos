/**
 * Background live-screen reading engine (Cluely-style).
 *
 * Loop (main process, immune to renderer churn):
 *   1. Briefly fade our own overlay out (Linux CLI screenshots capture the
 *      whole composited screen — without this we'd OCR our own answers).
 *      Windows/macOS desktopCapturer already excludes content-protected
 *      windows, so no flicker is needed there.
 *   2. Silent full-screen capture via the CLI-first chain.
 *   3. OCR with built-in perceptual-hash dedupe (ocr.ts skips identical
 *      frames), so an unchanged slide costs a hash, not a Tesseract run.
 *   4. Emit fresh text to the renderer, which feeds it into every assist.
 *
 * Gated by hasSilentScreenshotTool(): never loops on Wayland portal prompts.
 */

import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';
import { capturePrimaryScreen, hasSilentScreenshotTool } from './screenCapture.js';
import { extractTextFromImage } from './ocr.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type LiveTextEvent = { text: string; at: number };

class ScreenLiveEngine extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private running = false;
  private intervalMs = 2500;
  /** Injected by main/index.ts so we can fade the overlay without imports. */
  private windowsProvider: (() => BrowserWindow[]) | null = null;

  setWindowsProvider(provider: () => BrowserWindow[]) {
    this.windowsProvider = provider;
  }

  get isRunning() {
    return this.running;
  }

  async capable(): Promise<boolean> {
    return hasSilentScreenshotTool();
  }

  async start(intervalMs = 2500): Promise<{ ok: boolean; error?: string }> {
    if (this.running) await this.stop();
    if (!(await this.capable())) {
      return {
        ok: false,
        error:
          'Live screen needs a silent screenshot tool on Linux: sudo apt install gnome-screenshot',
      };
    }
    this.intervalMs = Math.max(1500, Math.min(10_000, intervalMs));
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return { ok: true };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.restoreOverlay();
  }

  private fadeOverlay() {
    if (process.platform !== 'linux') return [];
    const targets = (this.windowsProvider?.() ?? []).filter((w) => !w.isDestroyed());
    for (const w of targets) {
      try {
        w.setOpacity(0.01);
      } catch {
        /* ignore */
      }
    }
    return targets;
  }

  private restoreOverlay() {
    if (process.platform !== 'linux') return;
    const targets = (this.windowsProvider?.() ?? []).filter((w) => !w.isDestroyed());
    for (const w of targets) {
      try {
        w.setOpacity(1);
      } catch {
        /* ignore */
      }
    }
  }

  private async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    const faded = this.fadeOverlay();
    try {
      // Give the compositor a beat to actually remove us from the framebuffer.
      if (faded.length) await sleep(90);
      const cap = await capturePrimaryScreen();
      if (!this.running) return;
      if (cap.cancelled || !cap.dataUrl) {
        // Transient (e.g. tool hiccup) — stay alive; portal-only hosts are
        // rejected up front by capable(), so this should be rare.
        return;
      }
      const res = await extractTextFromImage({ base64: cap.dataUrl });
      if (!this.running) return;
      if (res.ok && res.text && res.text.trim()) {
        const ev: LiveTextEvent = { text: res.text.trim(), at: Date.now() };
        this.emit('text', ev);
      }
    } catch {
      /* transient failures keep the loop alive */
    } finally {
      if (faded.length) this.restoreOverlay();
      this.busy = false;
    }
  }
}

let shared: ScreenLiveEngine | null = null;

export function getScreenLiveEngine(): ScreenLiveEngine {
  if (!shared) shared = new ScreenLiveEngine();
  return shared;
}
