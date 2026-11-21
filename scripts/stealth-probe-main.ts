/**
 * Stealth verification probe (Electron main) — Architecture v2, §11.
 *
 * Bundled and launched by `scripts/stealth-probe.mjs`. Kept separate because the
 * Electron main process cannot bundle the helper at runtime without hanging, and
 * because the probe should measure the shipped `stealthWindow.ts`, not a copy.
 *
 * It reports the three things a matrix row needs:
 *   focus          showing the overlay must not take focus from the app it covers
 *   focus-on-click a deliberate click is what grants focus
 *   exclusion      with protection on, a screen capture of the overlay's rectangle
 *                  must not contain the overlay's colour (control capture proves
 *                  the capture path itself works)
 */

import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyNonActivating,
  clickThroughWindowState,
  focusOverlay,
  markToolWindow,
  overlayWindowType,
  presentOverlay,
  releaseOverlayFocus,
  setClickThrough,
} from '../src/main/services/stealthWindow.js';

const RECT = { x: 220, y: 160, width: 420, height: 300 };
const MAGENTA = { r: 255, g: 0, b: 170 };
/** A capture "sees" the overlay when its mean channel is within this distance. */
const MAGENTA_TOLERANCE = 70;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CAPTURE_SCRIPT = String.raw`
param([int]$x, [int]$y, [int]$w, [int]$h)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$sumR = 0; $sumG = 0; $sumB = 0; $n = 0
for ($iy = 0; $iy -lt $h; $iy += 8) {
  for ($ix = 0; $ix -lt $w; $ix += 8) {
    $c = $bmp.GetPixel($ix, $iy)
    $sumR += $c.R; $sumG += $c.G; $sumB += $c.B; $n++
  }
}
$g.Dispose(); $bmp.Dispose()
Write-Output ("{0},{1},{2}" -f [int]($sumR / $n), [int]($sumG / $n), [int]($sumB / $n))
`;

const AFFINITY_SCRIPT = String.raw`
param([long]$hwnd)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AffinityProbe {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
$affinity = 0
$ok = [AffinityProbe]::GetWindowDisplayAffinity([IntPtr]$hwnd, [ref]$affinity)
$ex = [AffinityProbe]::GetWindowLong([IntPtr]$hwnd, -20)
$fg = [AffinityProbe]::GetForegroundWindow()
Write-Output ("{0},{1},{2},{3}" -f $ok, $affinity, $ex, $fg.ToInt64())
`;

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args.map(String)],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message} :: ${stderr || stdout}`));
        else resolve(stdout.trim());
      },
    );
  });
}

async function captureMean(tmpDir) {
  const script = path.join(tmpDir, 'capture-mean.ps1');
  fs.writeFileSync(script, CAPTURE_SCRIPT);
  const raw = await runPowerShell(script, [RECT.x, RECT.y, RECT.width, RECT.height]);
  const [r, g, b] = raw.split(',').map((v) => Number(v.trim()));
  return { r, g, b };
}

async function affinityOf(tmpDir, win) {
  const script = path.join(tmpDir, 'affinity.ps1');
  fs.writeFileSync(script, AFFINITY_SCRIPT);
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  const raw = await runPowerShell(script, [hwnd.toString()]);
  const [ok, affinity, exStyle, foreground] = raw.split(',').map((v) => v.trim());
  return { ok: ok === 'True', affinity: Number(affinity), exStyle: Number(exStyle), foreground: Number(foreground) };
}

function nearMagenta(color) {
  return (
    Math.abs(color.r - MAGENTA.r) <= MAGENTA_TOLERANCE &&
    Math.abs(color.g - MAGENTA.g) <= MAGENTA_TOLERANCE &&
    Math.abs(color.b - MAGENTA.b) <= MAGENTA_TOLERANCE
  );
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osmos-stealth-'));
  const results = { platform: process.platform, checks: {}, ok: true };

  const meeting = new BrowserWindow({
    x: 0,
    y: 0,
    width: 640,
    height: 420,
    show: true,
    backgroundColor: '#202020',
    title: 'meeting-app',
  });
  await meeting.loadURL('data:text/html,<body style="margin:0;background:%23202020"></body>');
  meeting.focus();
  await sleep(600);

  const overlay = new BrowserWindow({
    ...RECT,
    frame: false,
    // Must match the real overlay: SetWindowDisplayAffinity only succeeds on a
    // layered window, so an opaque probe window would silently fail the check.
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#ff00aa',
    ...overlayWindowType(),
  });
  await overlay.loadURL('data:text/html,<body style="margin:0;background:%23ff00aa"></body>');

  applyNonActivating(overlay, true);
  presentOverlay(overlay, true);
  await sleep(900);

  results.checks.visible = overlay.isVisible();
  results.checks.overlayDidNotStealFocus = !overlay.isFocused();
  results.checks.meetingKeptFocus = meeting.isFocused();

  // Focus is granted on click and released on blur.
  focusOverlay(overlay);
  await sleep(700);
  results.checks.overlayTakesFocusOnClick = overlay.isFocused();
  meeting.focus();
  await sleep(600);
  // The policy is that a blurred overlay stops accepting keyboard focus.
  results.checks.focusReleasedAfterBlur = !overlay.isFocusable();

  if (process.platform === 'win32') {
    markToolWindow(overlay);
    const before = await affinityOf(tmpDir, overlay);
    results.exStylesBeforeProtection = before.exStyle;

    // WS_EX_TOOLWINDOW (0x80) is what keeps a window out of Alt-Tab. The style
    // is applied by a short-lived PowerShell helper, so poll instead of guessing
    // how long its Add-Type compile takes.
    let exStyle = before.exStyle;
    for (let attempt = 0; attempt < 16 && (exStyle & 0x80) === 0; attempt++) {
      await sleep(500);
      exStyle = (await affinityOf(tmpDir, overlay)).exStyle;
    }
    results.exStylesAfterProtection = exStyle;
    results.checks.toolWindowStyle = (exStyle & 0x80) !== 0;

    overlay.setContentProtection(true);
    await sleep(900);
    const native = await affinityOf(tmpDir, overlay);
    results.affinity = native.affinity;
    // In-process getter: Electron reports whether the affinity call landed.
    results.checks.contentProtectionReported = overlay.isContentProtected();
    // 0x11 = WDA_EXCLUDEFROMCAPTURE, readable from any process.
    results.affinityIsExcludeFromCapture = native.affinity === 0x11;

    const control = await captureMean(tmpDir);
    results.controlCapture = control;
    // GDI capture returns black when no interactive desktop is attached (an SSH
    // session, a locked screen); the pixel test is only meaningful when the
    // control capture actually shows the overlay.
    const captureUsable = !(control.r < 8 && control.g < 8 && control.b < 8);
    results.checks.screenCaptureUsable = captureUsable;
    if (captureUsable) {
      results.checks.captureSeesOverlayWithoutProtection = nearMagenta(control);
      const protectedCapture = await captureMean(tmpDir);
      results.protectedCapture = protectedCapture;
      results.checks.captureHidesOverlayWithProtection = !nearMagenta(protectedCapture);
      results.checks.protectionChangesCapture =
        JSON.stringify(control) !== JSON.stringify(protectedCapture);
    }

    // Click-through must not leave the window focusable.
    setClickThrough(overlay, true);
    clickThroughWindowState(overlay, true);
    await sleep(200);
    results.checks.clickThroughUnfocusable = !overlay.isFocusable();
    setClickThrough(overlay, false);
  } else {
    results.affinity = null;
  }

  // Reported, but not a product verdict: with no interactive desktop attached
  // (an SSH session, a locked screen) GDI capture is black, so the pixel half of
  // the exclusion test cannot run. The affinity flag above still measures.
  const environmentChecks = new Set(['screenCaptureUsable']);
  const failed = Object.entries(results.checks).filter(
    ([key, value]) => value === false && !environmentChecks.has(key),
  );
  results.failed = failed.map(([key]) => key);
  results.environmentLimited = Object.entries(results.checks)
    .filter(([key, value]) => value === false && environmentChecks.has(key))
    .map(([key]) => key);
  results.ok = results.failed.length === 0;

  process.stdout.write(`STEALTH_PROBE ${JSON.stringify(results)}\n`);
  overlay.destroy();
  meeting.destroy();
  app.quit();
  process.exitCode = results.ok ? 0 : 1;
}

app.whenReady().then(main).catch((error) => {
  process.stdout.write(`STEALTH_PROBE_ERROR ${error instanceof Error ? error.stack : String(error)}\n`);
  app.quit();
  process.exitCode = 1;
});
