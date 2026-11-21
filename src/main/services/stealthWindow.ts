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
Write-Output ("ex={0} want={1} now={2}" -f $ex, $want, [OsmosToolWindow]::GetWindowLong($h, -20))
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
  // Rewritten on every call: caching by "file exists" once ran a stale script
  // from an earlier version, which silently did nothing.
  let scriptPath: string;
  try {
    scriptPath = path.join(os.tmpdir(), 'osmos-toolwindow-v1.ps1');
    fs.writeFileSync(scriptPath, TOOL_WINDOW_SCRIPT, 'utf8');
  } catch {
    return;
  }

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, hwnd],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let diagnostics = '';
    child.stdout?.on('data', (buf: Buffer) => {
      diagnostics += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      diagnostics += buf.toString('utf8');
    });
    child.on('exit', (code) => {
      try {
        fs.writeFileSync(
          path.join(os.tmpdir(), 'osmos-toolwindow.log'),
          `hwnd=${hwnd} code=${code}\n${diagnostics}`,
          'utf8',
        );
      } catch {
        /* diagnostics only */
      }
    });
    // Deliberately not detached: a detached child in a new process group was
    // observed to exit 0 without its output reaching us, which hid the failure.
    // This process is short-lived and hidden.
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

/**
 * macOS: keep the overlay above a fullscreen meeting app.
 *
 * A fullscreen Zoom/Teams/Meet window gets its own Space and a raised window
 * level, so a normal floating overlay is covered by it — which the user reads
 * as "the overlay vanished when I went fullscreen". 'screen-saver' is the
 * highest level Electron exposes and is what other overlays use for this;
 * `visibleOnAllWorkspaces(..., visibleOnFullScreen)` is what keeps it on the
 * fullscreen Space. `skipTransformProcessType` matters: without it macOS turns
 * the app into an accessory (no Dock icon, no menu bar) just for this call.
 *
 * The window stays non-activating — this changes its level, not its focus.
 */
export function applyOverlayLevel(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (process.platform !== 'darwin') return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
  } catch {
    /* older Electron / non-macOS */
  }
  try {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  } catch {
    /* ignore */
  }
}

/** Show the overlay without activating it (§11 "don't steal focus"). */
export function presentOverlay(win: BrowserWindow, stealth: boolean): void {
  if (win.isDestroyed()) return;
  applyNonActivating(win, stealth);
  applyOverlayLevel(win);
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
  applyOverlayLevel(win);
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
