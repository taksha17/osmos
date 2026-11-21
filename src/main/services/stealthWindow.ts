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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL_WINDOW_SCRIPT = `param([long]$hwnd)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OsmosToolWindow {
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
"@
$h = [IntPtr]$hwnd
$ex = [OsmosToolWindow]::GetWindowLong($h, -20)
$want = ($ex -bor 0x80) -band (-bnot 0x40000)
if ($want -ne $ex) { [void][OsmosToolWindow]::SetWindowLong($h, -20, $want) }
`;

/**
 * Windows: give the overlay a tool-window style so it leaves the Alt-Tab list.
 *
 * Electron's `skipTaskbar` removes the taskbar button but does not set
 * WS_EX_TOOLWINDOW, and Windows keeps taskbar-hidden windows in Alt-Tab —
 * measured with `GetWindowLong(GWL_EXSTYLE)` on the real window. The flag can
 * only be set with SetWindowLongPtr, which needs the Win32 API; this app already
 * relies on PowerShell for its Windows screen and audio helpers, so it uses the
 * same route instead of adding a native module that would need a per-ABI rebuild.
 *
 * Fire-and-forget: failure must never block window creation, and the chip in the
 * UI stays honest because `verifyStealth` reports what the OS says.
 */
export function markToolWindow(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  let hwnd: string;
  try {
    const handle = win.getNativeWindowHandle();
    hwnd = (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
  } catch {
    return;
  }

  // The script is written to a file instead of passed with -Command: the here-string
  // needs literal newlines, and Node's argument escaping mangles them on Windows.
  let scriptPath: string;
  try {
    scriptPath = path.join(os.tmpdir(), 'osmos-toolwindow.ps1');
    if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, TOOL_WINDOW_SCRIPT, 'utf8');
  } catch {
    return;
  }

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, hwnd],
      { windowsHide: true, stdio: 'ignore', detached: true },
    );
    child.unref();
  } catch {
    /* style is best-effort; skipTaskbar still hides the taskbar button */
  }
}

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
  if (stealth) markToolWindow(win);
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
  // A window shown with showInactive() is not in the activation chain; it has to
  // be shown (or re-shown) before focus() can take, which is what a user click
  // on a non-activating overlay does anyway.
  win.show();
  win.focus();
  try {
    win.webContents.focus();
  } catch {
    /* ignore */
  }
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
