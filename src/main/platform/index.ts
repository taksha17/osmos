import type { BrowserWindow } from 'electron';
import type { AppSettings, CaptureResult, SystemAudioResponse } from '../../shared/types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

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
  // Portable lookup that doesn't depend on `which` (which can throw ENOTDIR
  // synchronously in some environments). We check PATH ourselves.
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = require('node:path').join(dir, command + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

async function tryCapture(command: string, args: string[], tmp: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore' });
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
      child = spawn(command, args, { stdio: ['ignore', out, 'ignore'] });
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
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
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
  captureSystemAudio(_durationMs?: number, _device?: string): Promise<SystemAudioResponse>;
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
        if (!ok) return { dataUrl: '', cancelled: true };
        try {
          const buffer = fs.readFileSync(tmp);
          const base64 = buffer.toString('base64');
          fs.unlinkSync(tmp);
          return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
        } catch {
          return { dataUrl: '', cancelled: true };
        }
      },
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
        'System audio: ffmpeg WASAPI loopback (install ffmpeg on PATH). Without ffmpeg, loopback is unavailable.',
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
        if (!ok) return { dataUrl: '', cancelled: true };
        try {
          const buffer = fs.readFileSync(tmp);
          const base64 = buffer.toString('base64');
          fs.unlinkSync(tmp);
          return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
        } catch {
          return { dataUrl: '', cancelled: true };
        }
      },
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
            error: 'Windows system audio needs ffmpeg on PATH with WASAPI loopback support. Install ffmpeg and retry.',
          };
        }
        return {
          ok: false,
          error: 'Windows system audio needs ffmpeg on PATH with WASAPI loopback support (e.g. winget install ffmpeg).',
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
      'System audio: pw-record (PipeWire) or timed parec monitor → WAV for continuous Smart listen.',
      'Region capture uses gnome-screenshot or spectacle.',
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
          return { dataUrl: '', cancelled: true };
        }
      }
      if (await tryCapture('spectacle', ['-r', '-n', '-b', '-o', tmp], tmp)) {
        try {
          const buffer = fs.readFileSync(tmp);
          const base64 = buffer.toString('base64');
          fs.unlinkSync(tmp);
          return { dataUrl: `data:image/png;base64,${base64}`, cancelled: false };
        } catch {
          return { dataUrl: '', cancelled: true };
        }
      }
      return { dataUrl: '', cancelled: true };
    },
    captureSystemAudio: async (durationMs = 5_000, device?: string) => {
      const tmp = path.join(os.tmpdir(), `osmos-audio-${Date.now()}.wav`);
      const durationSec = Math.max(1, Math.round(durationMs / 1000));
      const named = preferredAudioDevice(device);
      if (named) {
        if (
          await tryCapture(
            'pw-record',
            [
              `--target=${named}`,
              `--duration=${durationSec}`,
              '--format=s16',
              '--rate=16000',
              '--channels=1',
              tmp,
            ],
            tmp,
          )
        ) {
          return readAudioFile(tmp);
        }
        const namedPcm = path.join(os.tmpdir(), `osmos-audio-${Date.now()}.pcm`);
        if (
          await tryCaptureTimed(
            'parec',
            ['--format=s16le', '--rate=16000', '--channels=1', '-d', named],
            namedPcm,
            durationMs,
          )
        ) {
          try {
            const pcm = fs.readFileSync(namedPcm);
            fs.unlinkSync(namedPcm);
            const wav = wrapPcmS16leAsWav(pcm, 16000, 1);
            fs.writeFileSync(tmp, wav);
            return readAudioFile(tmp);
          } catch {
            try {
              fs.unlinkSync(namedPcm);
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (await tryCapture('pw-record', [`--duration=${durationSec}`, '--format=s16', '--rate=16000', '--channels=1', tmp], tmp)) {
        return readAudioFile(tmp);
      }
      if (await tryCapture('pw-record', [`--duration=${durationSec}`, tmp], tmp)) {
        return readAudioFile(tmp);
      }
      const pcmTmp = path.join(os.tmpdir(), `osmos-audio-${Date.now()}.pcm`);
      const parecOk = await tryCaptureTimed(
        'parec',
        ['--format=s16le', '--rate=16000', '--channels=1', '-d', '@DEFAULT_MONITOR@'],
        pcmTmp,
        durationMs,
      );
      if (parecOk) {
        try {
          const pcm = fs.readFileSync(pcmTmp);
          fs.unlinkSync(pcmTmp);
          const wav = wrapPcmS16leAsWav(pcm, 16000, 1);
          fs.writeFileSync(tmp, wav);
          return readAudioFile(tmp);
        } catch {
          try {
            fs.unlinkSync(pcmTmp);
          } catch {
            /* ignore */
          }
        }
      }
      const hasPw = await hasOnPath('pw-record');
      const hasParec = await hasOnPath('parec');
      if (!hasPw && !hasParec) {
        return {
          ok: false,
          error: 'System audio capture needs either PipeWire or PulseAudio tools. On Ubuntu/Debian install: sudo apt install pipewire pulseaudio-utils',
        };
      }
      return {
        ok: false,
        error: 'System audio capture failed. If you are on PipeWire, install pw-record; on PulseAudio, install parec.',
      };
    },
  };
}

export type { AppSettings };
