/**
 * Non-activating overlay behaviour — Architecture v2, §11.
 *
 * The overlay is a *utility surface*: it is visible, top-most and interactive,
 * but it must not become the foreground window or take keyboard focus away from
 * the meeting app unless the user deliberately clicks it. Electron exposes the
 * pieces (`showInactive`, `setFocusable`, `setIgnoreMouseEvents`,
 * `setSkipTaskbar`); this module holds the policy so `src/main/index.ts` only
 * calls one function per event.
 *
 * Kept Electron-only (no imports beyond types) so a probe can drive it directly
 * on a real desktop: `scripts/stealth-probe.mjs` builds this file with esbuild and
 * runs it under Electron to measure focus and capture behaviour.
 */

import type { BrowserWindow } from 'electron';

/**
 * Apply the platform's non-activating window style.
 *
 * macOS gets this from `type: 'panel'` at creation (pass `overlayWindowType()`);
 * Windows and Linux get it from `setFocusable(false)` plus presenting with
 * `showInactive()`. Call again after the window is recreated.
 */
export function applyNonActivating(win: BrowserWindow, stealth: boolean): void {
  if (win.isDestroyed()) return;
  try {
    // An interactive (non-click-through) overlay still needs to accept clicks,
    // which a non-focusable window does; it only refuses keyboard focus.
    win.setFocusable(!stealth);
  } catch {
    /* older Electron */
  }
}

/** Show the overlay without activating it (§11 "don't steal focus"). */
export function presentOverlay(win: BrowserWindow, stealth: boolean): void {
  if (win.isDestroyed()) return;
  applyNonActivating(win, stealth);
  if (stealth) win.showInactive();
  else win.show();
}

/**
 * The user clicked the overlay: allow it to take focus, and only then activate.
 * Paired with `releaseOverlayFocus` on blur so it goes back to being passive.
 */
export function focusOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    win.setFocusable(true);
  } catch {
    /* ignore */
  }
  win.focus();
}

/** Focus left the overlay: return to the non-activating state. */
export function releaseOverlayFocus(win: BrowserWindow, stealth: boolean): void {
  if (win.isDestroyed()) return;
  applyNonActivating(win, stealth);
}

/**
 * Click-through mode: mouse events pass to whatever is underneath, and
 * `forward: true` keeps move events so the renderer can still highlight itself.
 * The global shortcut toggles it back, because a click-through window cannot be
 * clicked to escape.
 */
export function setClickThrough(win: BrowserWindow, enabled: boolean): boolean {
  if (win.isDestroyed()) return false;
  try {
    win.setIgnoreMouseEvents(enabled, { forward: true });
  } catch {
    return false;
  }
  return enabled;
}

/** A click-through window must not keep keyboard focus. */
export function clickThroughWindowState(win: BrowserWindow, enabled: boolean): void {
  if (win.isDestroyed()) return;
  try {
    if (enabled) win.setFocusable(false);
  } catch {
    /* ignore */
  }
}

/**
 * macOS uses an `NSPanel` for a surface that can be shown without activating the
 * app; other platforms use a normal frameless window.
 */
export function overlayWindowType(): { type?: 'panel' } {
  return process.platform === 'darwin' ? { type: 'panel' } : {};
}
