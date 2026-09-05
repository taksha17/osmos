/**
 * Background live-screen reading engine — main-process.
 *
 * Backend priority (all silent, none steal a Zoom/Meet share):
 *   1. **Mutter ScreenCast** (GNOME Linux): `mutterScreenCast.ts` drives a
 *      python + GStreamer worker over `org.gnome.Mutter.ScreenCast`. NO
 *      permission dialog, NO screen flash — the preferred path on GNOME Wayland
 *      where the portal shows a picker and gnome-screenshot flashes.
 *   2. **Silent CLI loop** (Windows GDI, macOS `screencapture`, KDE
 *      `spectacle`, wlroots `grim`, X11 `scrot`) via `capturePrimaryScreen`.
 *      Refuses to run where the only tool flashes (GNOME `gnome-screenshot`).
 *
 * Both backends OCR with hash dedupe (ocr.ts) and emit `text`; the renderer
 * strips overlay self-echo (`shared/screenContext.ts`) and attaches it to the
 * next question. The renderer's getDisplayMedia portal path is now only a
 * last-resort fallback when neither main backend is available.
 *
 * Note: we do NOT hide the overlay before shooting. `setOpacity` is a no-op on
 * Linux, and Windows/macOS already exclude the content-protected overlay.
 */

import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { capturePrimaryScreen, describeLoopSafeCapture } from './screenCapture.js';
import { extractTextFromImage } from './ocr.js';
import {
  MutterScreenCastBackend,
  probeMutterScreenCast,
  type MutterFrame,
} from './mutterScreenCast.js';

type LiveTextEvent = { text: string; at: number };

class ScreenLiveEngine extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private running = false;
  private intervalMs = 2500;
  private windowsProvider: (() => BrowserWindow[]) | null = null;
  private mutter: MutterScreenCastBackend | null = null;
  private mutterBusy = false;

  /** Kept for API compatibility with main/index.ts; not needed for capture. */
  setWindowsProvider(provider: () => BrowserWindow[]) {
    this.windowsProvider = provider;
  }

  get isRunning() {
    return this.running;
  }

  async capable(): Promise<boolean> {
    return probeMutterScreenCast().ok || describeLoopSafeCapture().ok;
  }

  async start(intervalMs = 2500): Promise<{ ok: boolean; error?: string; backend?: string }> {
    if (this.running) await this.stop();
    this.intervalMs = Math.max(1500, Math.min(10_000, intervalMs));

    // 1) Preferred: Mutter ScreenCast — no dialog, no flash (GNOME Linux).
    if (probeMutterScreenCast().ok) {
      const started = await this.startMutter(this.intervalMs);
      if (started.ok) return { ok: true, backend: 'mutter-screencast' };
      console.warn('[screenLive] Mutter ScreenCast unavailable, trying CLI:', started.error);
    }

    // 2) Silent CLI loop where a non-flashing tool exists.
    const gate = describeLoopSafeCapture();
    if (!gate.ok) {
      return { ok: false, error: gate.reason || 'No silent screen-read backend on this system.' };
    }
    this.running = true;
    console.log(`[screenLive] CLI loop started via ${gate.tool} every ${this.intervalMs}ms`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return { ok: true, backend: `cli:${gate.tool}` };
  }

  private async startMutter(intervalMs: number): Promise<{ ok: boolean; error?: string }> {
    const backend = new MutterScreenCastBackend();
    this.mutter = backend;
    backend.on('frame', (frame: MutterFrame) => void this.onMutterFrame(frame));
    backend.on('error', (error: string) => {
      this.emit('error', error);
      void this.stop();
    });
    const res = await backend.start(intervalMs, 1440);
    if (res.ok) {
      this.running = true;
      console.log('[screenLive] Mutter ScreenCast backend live (no dialog, no flash)');
    } else {
      this.mutter = null;
    }
    return res;
  }

  private async onMutterFrame(frame: MutterFrame) {
    if (!this.running || this.mutterBusy) return; // backpressure: one OCR at a time
    this.mutterBusy = true;
    try {
      const res = await extractTextFromImage({ base64: frame.dataUrl });
      if (!this.running) return;
      if (res.ok && res.text && res.text.trim()) {
        this.emit('text', { text: res.text.trim(), at: frame.at } as LiveTextEvent);
      }
    } catch (e) {
      console.warn('[screenLive] mutter OCR failed:', e instanceof Error ? e.message : e);
    } finally {
      this.mutterBusy = false;
    }
  }

  /**
   * One silent OCR of the current screen. Prefers the live Mutter session
   * (latest frame) so 📷 never opens a picker or flashes gnome-screenshot.
   */
  async grabOnce(): Promise<{ ok: boolean; text?: string; at?: number; error?: string }> {
    if (this.mutter?.isRunning) {
      const frame = this.mutter.lastFrame || (await this.waitMutterFrame(7000));
      if (frame) return this.ocrFrame(frame);
    }
    if (this.running) {
      // CLI loop is mid-tick; do a single silent capture.
      try {
        const cap = await capturePrimaryScreen({ loopSafe: true });
        if (cap.dataUrl) return this.ocrFrame({ dataUrl: cap.dataUrl, at: Date.now() });
        return { ok: false, error: cap.error || 'No frame' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (probeMutterScreenCast().ok) {
      const started = await this.startMutter(2000);
      if (!started.ok) return { ok: false, error: started.error };
      const frame = await this.waitMutterFrame(7000);
      if (!frame) {
        await this.stop();
        return { ok: false, error: 'Mutter produced no frame' };
      }
      const ocr = await this.ocrFrame(frame);
      await this.stop();
      return ocr;
    }

    // Windows GDI / macOS screencapture / KDE spectacle / grim / scrot.
    try {
      const cap = await capturePrimaryScreen({ loopSafe: true });
      if (cap.dataUrl) return this.ocrFrame({ dataUrl: cap.dataUrl, at: Date.now() });
      if (process.platform === 'darwin') {
        return {
          ok: false,
          error:
            cap.error ||
            'macOS screen grab failed. Grant Screen Recording to OSMOS in System Settings → Privacy & Security, then retry.',
        };
      }
      if (process.platform === 'win32') {
        return {
          ok: false,
          error: cap.error || 'Windows screen grab failed (GDI/PowerShell). Try 👁 Live instead.',
        };
      }
      return { ok: false, error: cap.error || 'Silent screen grab is not available on this desktop.' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private waitMutterFrame(ms: number): Promise<MutterFrame | null> {
    const existing = this.mutter?.lastFrame;
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mutter?.off('frame', onFrame);
        resolve(this.mutter?.lastFrame || null);
      }, ms);
      const onFrame = (frame: MutterFrame) => {
        clearTimeout(timer);
        this.mutter?.off('frame', onFrame);
        resolve(frame);
      };
      this.mutter?.once('frame', onFrame);
    });
  }

  private async ocrFrame(frame: MutterFrame): Promise<{ ok: boolean; text?: string; at?: number; error?: string }> {
    try {
      const res = await extractTextFromImage({ base64: frame.dataUrl });
      if (res.ok && res.text?.trim()) {
        return { ok: true, text: res.text.trim(), at: frame.at };
      }
      return { ok: false, error: res.error || 'OCR returned no text' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.mutter) {
      const m = this.mutter;
      this.mutter = null;
      await m.stop().catch(() => undefined);
    }
  }

  private async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const cap = await capturePrimaryScreen({ loopSafe: true });
      if (!this.running) return;
      if (cap.cancelled || !cap.dataUrl) {
        if (cap.error) {
          // Tool disappeared / refused — stop instead of spinning.
          console.warn('[screenLive] capture unavailable, stopping:', cap.error);
          this.emit('error', cap.error);
          await this.stop();
        }
        return;
      }
      const res = await extractTextFromImage({ base64: cap.dataUrl });
      if (!this.running) return;
      if (res.ok && res.text && res.text.trim()) {
        const ev: LiveTextEvent = { text: res.text.trim(), at: Date.now() };
        this.emit('text', ev);
      }
    } catch (e) {
      console.warn('[screenLive] tick failed:', e instanceof Error ? e.message : e);
    } finally {
      this.busy = false;
    }
  }
}

let shared: ScreenLiveEngine | null = null;

export function getScreenLiveEngine(): ScreenLiveEngine {
  if (!shared) shared = new ScreenLiveEngine();
  return shared;
}
