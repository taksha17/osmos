import type { BrowserWindow } from 'electron';
import type { AppSettings, CaptureResult, SystemAudioResponse } from '../../shared/types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { findOnPath, resolveCaptureTool, resolveFfmpeg, safeSpawnCwd } from '../services/resolveBin.js';
import {
  listLinuxAudioDevices,
  resolveLinuxMicSource,
} from '../services/audioDevices.js';
import { capturePrimaryScreen, canLoopSafeScreenCapture, type CaptureScreenOptions } from '../services/screenCapture.js';
import { captureLinuxMonitorOnce } from '../services/linuxLoopbackStream.js';

export type PlatformId = 'linux' | 'darwin' | 'win32';

/**
 * OS-level capture exclusion for meeting apps (Zoom, Teams, Meet, Webex, etc.).
 * - Windows: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) via setContentProtection
 * - macOS: NSWindowSharingNone via setContentProtection (legacy APIs; ScreenCaptureKit on
 *   newer macOS may still capture — prefer window/tab share as backup)
 * - Linux: no equivalent OS flag
 */
export function applyOsCaptureExclusion(win: BrowserWindow, enabled: boolean, platformId: PlatformId) {
  if (win.isDestroyed()) return;

  win.setSkipTaskbar(enabled);

  if (platformId === 'win32' || platformId === 'darwin') {
    try {
      // Windows workaround: force a layered opacity refresh before affinity so
      // WDA_EXCLUDEFROMCAPTURE sticks across show/hide cycles on some builds.
      if (platformId === 'win32') {
        try {
          const opacity = win.getOpacity();
          win.setOpacity(Math.min(1, Math.max(0.85, opacity || 1)));
        } catch {
          /* ignore */
        }
      }
      win.setContentProtection(enabled);
    } catch {
      /* older Electron */
    }
  }

  try {
    win.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: true });
  } catch {
    /* ignore */
  }

  if (enabled) {
    try {
      // High z-order so the assistant stays above meeting windows.
      win.setAlwaysOnTop(true, 'screen-saver', 1);
    } catch {
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
      } catch {
        /* ignore */
      }
    }
  }
}

async function hasOnPath(command: string): Promise<boolean> {
  if (command === 'ffmpeg') return Boolean(resolveFfmpeg());
  return Boolean(findOnPath(command));
}

async function tryCapture(command: string, args: string[], tmp: string): Promise<boolean> {
  const bin =
    resolveCaptureTool(command) ||
    (command.includes(path.sep) || command.includes('/') ? command : null);
  if (!bin) return false;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmp)) {
        const stat = fs.statSync(tmp);
        if (stat.size > 0) resolve(true);
        else {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          resolve(false);
        }
      } else {
        resolve(false);
      }
    });
  });
}

/** Run a capture that does not self-terminate (e.g. parec); kill after durationMs. Writes stdout to tmp. */
async function tryCaptureTimed(
  command: string,
  args: string[],
  tmp: string,
  durationMs: number,
): Promise<boolean> {
  const bin =
    resolveCaptureTool(command) ||
    (command.includes(path.sep) || command.includes('/') ? command : null);
  if (!bin) return false;
  return new Promise((resolve) => {
    let out: number | undefined;
    try {
      out = fs.openSync(tmp, 'w');
    } catch {
      resolve(false);
      return;
    }
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', out, 'ignore'],
        cwd: safeSpawnCwd(),
        windowsHide: true,
      });
    } catch {
      try { if (out !== undefined) fs.closeSync(out); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        if (out !== undefined) fs.closeSync(out);
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, durationMs);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        if (out !== undefined) fs.closeSync(out);
      } catch {
        /* ignore */
      }
      out = undefined;
      if (fs.existsSync(tmp)) {
        try {
          if (fs.statSync(tmp).size > 0) finish(true);
          else finish(false);
        } catch {
          finish(false);
        }
      } else finish(false);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Serialize PipeWire/Pulse captures — concurrent pw-record breaks with thread-loop errors. */
let linuxAudioLock: Promise<void> = Promise.resolve();

function withLinuxAudioLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = linuxAudioLock.then(fn, fn);
  linuxAudioLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** pw-record has no --duration on many PipeWire builds — record to file, kill after durationMs. */
async function tryPwRecordTimed(
  target: string | undefined,
  tmp: string,
  durationMs: number,
): Promise<boolean> {
  const bin = resolveCaptureTool('pw-record');
  if (!bin) return false;
  const args = ['--rate=16000', '--channels=1', '--format=s16'];
  if (target) args.push(`--target=${target}`);
  args.push(tmp);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', cwd: safeSpawnCwd(), windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // Give pw-record a moment to flush the WAV header after SIGTERM.
      setTimeout(() => {
        if (ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 400) resolve(true);
        else {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          resolve(false);
        }
      }, 120);
    };
    const timer = setTimeout(() => finish(true), durationMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish(true);
    });
  });
}

function wrapPcmS16leAsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

const LOOPBACK_DEVICE_RE = /blackhole|loopback|soundflower|aggregate|multi-output|virtual/i;

let avAudioCache: { at: number; devices: Array<{ index: number; name: string }> } | null = null;

function preferredAudioDevice(explicit?: string): string {
  return (explicit || process.env.OSMOS_AUDIO_DEVICE || '').trim();
}

function listAvfoundationAudioDevices(): Promise<Array<{ index: number; name: string }>> {
  if (avAudioCache && Date.now() - avAudioCache.at < 30_000) {
    return Promise.resolve(avAudioCache.devices);
  }
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) {
      resolve([]);
      return;
    }
    let child;
    try {
      child = spawn(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
        cwd: safeSpawnCwd(),
      });
    } catch {
      resolve([]);
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 5000);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const finish = () => {
      clearTimeout(timer);
      const audioPart = stderr.split(/AVFoundation audio devices:/i)[1] || '';
      const section = audioPart.split(/AVFoundation video devices:/i)[0] || audioPart;
      const devices: Array<{ index: number; name: string }> = [];
      const re = /\[(\d+)\]\s+(.+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(section))) {
        devices.push({ index: Number(match[1]), name: match[2].trim() });
      }
      avAudioCache = { at: Date.now(), devices };
      resolve(devices);
    };
    child.on('close', finish);
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function resolveMacAudioInput(
  devices: Array<{ index: number; name: string }>,
  preferred?: string,
): { spec: string; usedLoopback: boolean; label: string } {
  const want = preferredAudioDevice(preferred);
  if (want) {
    const byName = devices.find(
      (d) =>
        d.name.toLowerCase() === want.toLowerCase() ||
        d.name.toLowerCase().includes(want.toLowerCase()),
    );
    if (byName) return { spec: `:${byName.index}`, usedLoopback: true, label: byName.name };
    if (/^\d+$/.test(want)) return { spec: `:${want}`, usedLoopback: true, label: want };
    return { spec: want.startsWith(':') ? want : `:${want}`, usedLoopback: true, label: want };
  }
  const loop = devices.find((d) => LOOPBACK_DEVICE_RE.test(d.name));
  if (loop) return { spec: `:${loop.index}`, usedLoopback: true, label: loop.name };
  const fallback = devices[0];
  return {
    spec: fallback ? `:${fallback.index}` : ':0',
    usedLoopback: false,
    label: fallback?.name || 'default :0',
  };
}

const MAC_LOOPBACK_HELP =
  'macOS meeting audio needs a virtual loopback. Install BlackHole (https://existential.audio/blackhole/), open Audio MIDI Setup → create a Multi-Output Device with your speakers + BlackHole, set it as system output, then put the BlackHole name in Settings → Speech → Loopback device (or OSMOS_AUDIO_DEVICE). Also requires ffmpeg on PATH.';

async function readAudioFile(tmp: string): Promise<SystemAudioResponse> {
  try {
    const base64 = await fs.promises.readFile(tmp, 'base64');
    await fs.promises.unlink(tmp).catch(() => undefined);
    return { ok: true, base64, mimeType: 'audio/wav' };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: 'Failed to read captured audio' };
  }
}

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  /** Notes shown in Settings about OS-specific limits. */
  capabilityNotes(): string[];
  applyStealth(enabled: boolean, windows: Electron.BrowserWindow[]): void;
  defaultShortcutModifier(): 'Alt' | 'CommandOrControl';
  captureRegion(): Promise<CaptureResult>;
  /** Silent full-screen capture (no interactive region picker). Pass loopSafe for continuous OCR. */
  captureFullScreen(opts?: CaptureScreenOptions): Promise<CaptureResult>;
  captureSystemAudio(_durationMs?: number, _device?: string): Promise<SystemAudioResponse>;
  captureMicAudio?(_durationMs?: number, _device?: string): Promise<SystemAudioResponse>;
}

export function detectPlatform(): PlatformId {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

export function createPlatformAdapter(): PlatformAdapter {
  const id = detectPlatform();
  if (id === 'darwin') {
    return {
      id,
      displayName: 'macOS',
      capabilityNotes: () => [
        'Screen Recording + Accessibility permissions may be required.',
        'Stealth uses NSWindowSharingNone (Electron setContentProtection) so many capture apps omit Osmos.',
        'On newer macOS, some ScreenCaptureKit-based shares can still include the window — prefer sharing a single app/tab, not the full desktop.',
        'System audio: ffmpeg prefers a BlackHole / Loopback / Soundflower device automatically. Install BlackHole, route output through a Multi-Output Device, or set Settings → Speech → Loopback device.',
      ],
      applyStealth(enabled, windows) {
        for (const win of windows) applyOsCaptureExclusion(win, enabled, 'darwin');
      },
      defaultShortcutModifier: () => 'CommandOrControl',
      captureRegion: async () => {
        const tmp = path.join(os.tmpdir(), `uncon-capture-${Date.now()}.png`);
        const ok = await tryCapture('screencapture', ['-i', tmp], tmp);
        if (ok) {
          try {
            const buffer = fs.readFileSync(tmp);
            const base64 = buffer.toString('base64');
            fs.unlinkSync(tmp);
            return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
          } catch {
            return { dataUrl: '', cancelled: true };
          }
        }
        return capturePrimaryScreen();
      },
      captureFullScreen: (opts) => capturePrimaryScreen(opts),
      captureSystemAudio: async (durationMs = 5_000, device?: string) => {
        const tmp = path.join(os.tmpdir(), `osmos-audio-${Date.now()}.wav`);
        const durationSec = Math.max(1, Math.round(durationMs / 1000));
        const devices = await listAvfoundationAudioDevices();
        const picked = resolveMacAudioInput(devices, device);
        const specs = [picked.spec];
        if (picked.spec !== ':0') specs.push(':0');
        for (const spec of specs) {
          const ffmpegArgs = [
            '-f',
            'avfoundation',
            '-i',
            spec,
            '-t',
            String(durationSec),
            '-ac',
            '1',
            '-ar',
            '16000',
            '-y',
            tmp,
          ];
          if (await tryCapture('ffmpeg', ffmpegArgs, tmp)) return readAudioFile(tmp);
        }
        const recArgs = ['-d', String(durationSec), tmp];
        if (await tryCapture('rec', recArgs, tmp)) return readAudioFile(tmp);
        return { ok: false, error: MAC_LOOPBACK_HELP };
      },
    };
  }
  if (id === 'win32') {
    return {
      id,
      displayName: 'Windows',
      capabilityNotes: () => [
        'Stealth uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) via setContentProtection — hides Osmos from Zoom, Teams, Meet, Webex, OBS, and similar on Windows 10 2004+ / Windows 11.',
        'System audio: Chromium desktop loopback (ffmpeg has no WASAPI input). Play audio on speakers while Smart is on.',
        'Region capture falls back to full-screen screenshot via PowerShell.',
      ],
      applyStealth(enabled, windows) {
        for (const win of windows) applyOsCaptureExclusion(win, enabled, 'win32');
      },
      defaultShortcutModifier: () => 'Alt',
      captureRegion: async () => {
        const tmp = path.join(os.tmpdir(), `uncon-capture-${Date.now()}.png`);
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
        const ok = await tryCapture('powershell', ['-NoProfile', '-Command', psScript], tmp);
        if (ok) {
          try {
            const buffer = fs.readFileSync(tmp);
            const base64 = buffer.toString('base64');
            fs.unlinkSync(tmp);
            return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
          } catch {
            /* fall through */
          }
        }
        return capturePrimaryScreen();
      },
      captureFullScreen: (opts) => capturePrimaryScreen(opts),
      captureSystemAudio: async (durationMs = 5_000, device?: string) => {
        const tmp = path.join(os.tmpdir(), `osmos-audio-${Date.now()}.wav`);
        const durationSec = Math.max(1, Math.round(durationMs / 1000));
        const named = preferredAudioDevice(device);
        if (named) {
          const ffmpegNamed = [
            '-f',
            'wasapi',
            '-i',
            named,
            '-t',
            String(durationSec),
            '-ac',
            '1',
            '-ar',
            '16000',
            '-y',
            tmp,
          ];
          if (await tryCapture('ffmpeg', ffmpegNamed, tmp)) return readAudioFile(tmp);
        }
        const ffmpegLoopback = [
          '-f',
          'wasapi',
          '-i',
          'loopback',
          '-t',
          String(durationSec),
          '-ac',
          '1',
          '-ar',
          '16000',
          '-y',
          tmp,
        ];
        if (await tryCapture('ffmpeg', ffmpegLoopback, tmp)) return readAudioFile(tmp);
        const ffmpegDefault = [
          '-f',
          'wasapi',
          '-i',
          'default',
          '-t',
          String(durationSec),
          '-ac',
          '1',
          '-ar',
          '16000',
          '-y',
          tmp,
        ];
        if (await tryCapture('ffmpeg', ffmpegDefault, tmp)) return readAudioFile(tmp);
        const hasFfmpeg = await hasOnPath('ffmpeg');
        if (!hasFfmpeg) {
          return {
            ok: false,
            error:
              'Audio engine missing: bundled ffmpeg was not found. Reinstall OSMOS, or install ffmpeg and restart the app.',
          };
        }
        const ffmpegBin = resolveFfmpeg();
        let demuxers = '';
        try {
          if (ffmpegBin) {
            const { execFileSync } = await import('node:child_process');
            demuxers = execFileSync(ffmpegBin, ['-hide_banner', '-demuxers'], {
              encoding: 'utf8',
              windowsHide: true,
              timeout: 10_000,
            });
          }
        } catch {
          /* ignore probe errors */
        }
        if (demuxers && !/\bwasapi\b/i.test(demuxers)) {
          return {
            ok: false,
            error:
              'ffmpeg has no WASAPI input on modern Windows builds. OSMOS uses Chromium desktop loopback instead — enable Smart from the overlay (not this ffmpeg path).',
          };
        }
        return {
          ok: false,
          error:
            'Windows system audio capture failed. Play audio on speakers and use Smart listen from the overlay.',
        };
      },
    };
  }
  return {
    id: 'linux',
    displayName: 'Linux',
    capabilityNotes: () => [
      'Wayland global shortcuts are often unavailable — use in-app controls.',
      'Stealth: skip taskbar + always-on-top. Linux has no OS capture-exclusion flag — share a browser tab/window, not the full desktop.',
      'System audio: ffmpeg pulse or pw-record on the default sink *.monitor (meeting audio). Not screen-share.',
      canLoopSafeScreenCapture()
        ? 'Continuous screen OCR uses CLI tools (grim / gnome-screenshot / spectacle / scrot) — never loops the Wayland portal.'
        : 'Continuous screen OCR needs grim, gnome-screenshot, spectacle, or scrot. 📷 one-shot may still use the portal.',
    ],
    applyStealth(enabled, windows) {
      for (const win of windows) {
        applyOsCaptureExclusion(win, enabled, 'linux');
        if (win.isDestroyed()) continue;
        try {
          win.setHasShadow(!enabled);
        } catch {
          /* ignore */
        }
      }
    },
    defaultShortcutModifier: () => 'Alt',
    captureRegion: async () => {
      const tmp = path.join(os.tmpdir(), `uncon-capture-${Date.now()}.png`);
      if (await tryCapture('gnome-screenshot', ['-a', '-f', tmp], tmp)) {
        try {
          const buffer = fs.readFileSync(tmp);
          const base64 = buffer.toString('base64');
          fs.unlinkSync(tmp);
          return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
        } catch {
          /* fall through */
        }
      }
      if (await tryCapture('spectacle', ['-r', '-n', '-b', '-o', tmp], tmp)) {
        try {
          const buffer = fs.readFileSync(tmp);
          const base64 = buffer.toString('base64');
          fs.unlinkSync(tmp);
          return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
        } catch {
          /* fall through */
        }
      }
      // Ubuntu Wayland often has neither gnome-screenshot nor spectacle.
      // Do NOT fall back to desktopCapturer here for interactive region — that
      // pops the portal. Use captureFullScreen() for on-demand OCR instead.
      return { dataUrl: '', cancelled: true };
    },
    captureFullScreen: (opts) => capturePrimaryScreen(opts),
    captureSystemAudio: async (durationMs = 5_000, device?: string) => {
      // parec is broken empty on many PipeWire hosts — use ffmpeg pulse / pw-record.
      return withLinuxAudioLock(() => captureLinuxMonitorOnce(durationMs, device));
    },
    captureMicAudio: async (durationMs = 5_000, device?: string) => {
      return withLinuxAudioLock(async () => {
      const tmp = path.join(os.tmpdir(), `osmos-mic-${Date.now()}.wav`);
      const list = await listLinuxAudioDevices();
      const source = resolveLinuxMicSource(device, list);
      const target =
        source && source !== 'default' ? source : list.preferredInputId || list.inputs[0]?.id;

      if (!target || target === 'default') {
        return {
          ok: false,
          error: 'No microphone source found. Check Settings → Speech → Microphone.',
        };
      }

      const durationSec = Math.max(1, Math.round(durationMs / 1000));
      const ffmpeg = resolveFfmpeg();
      if (ffmpeg) {
        if (
          await tryCapture(
            'ffmpeg',
            [
              '-nostdin',
              '-hide_banner',
              '-loglevel',
              'error',
              '-f',
              'pulse',
              '-i',
              target,
              '-t',
              String(durationSec),
              '-ac',
              '1',
              '-ar',
              '16000',
              '-y',
              tmp,
            ],
            tmp,
          )
        ) {
          return readAudioFile(tmp);
        }
      }

      if (await tryPwRecordTimed(target, tmp, durationMs)) {
        return readAudioFile(tmp);
      }

      return {
        ok: false,
        error: `Microphone capture failed (source: ${target}). Check Settings → Speech or pick another mic.`,
      };
      });
    },
  };
}

export type { AppSettings };
