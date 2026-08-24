export type AudioCapturePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

export type AudioCaptureBackend =
  | 'native-module'
  | 'electron-display-loopback'
  | 'ffmpeg-pulse-stream'
  | 'pw-record'
  | 'ffmpeg-blackhole'
  | 'mediarecorder'
  | 'none';

export type AudioPathProfile = {
  primary: AudioCaptureBackend;
  fallback: AudioCaptureBackend[];
  notes: string;
};

export type AudioRuntimeProfile = {
  sampleRate: 16_000;
  channels: 1;
  chunkMs: 250;
  silenceRms: 0.006;
  maxInFlight: 3;
  lazyOpen: true;
  deferStop: true;
  keepAliveMs: 15_000;
};

export type AudioCaptureProfile = {
  platform: AudioCapturePlatform;
  system: AudioPathProfile;
  mic: AudioPathProfile;
  runtime: AudioRuntimeProfile;
  deviceHints: {
    preferSystemMonitorOnLinux: boolean;
    preferVirtualCableOnMac: boolean;
    preferLoopbackOnWindows: boolean;
  };
  summary: string;
  warnings: string[];
};

const RUNTIME: AudioRuntimeProfile = {
  sampleRate: 16_000,
  channels: 1,
  chunkMs: 250,
  silenceRms: 0.006,
  maxInFlight: 3,
  lazyOpen: true,
  deferStop: true,
  keepAliveMs: 15_000,
};

function detectPlatform(platform: string | NodeJS.Platform | undefined = process.platform): AudioCapturePlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'unknown';
}

function systemPath(platform: AudioCapturePlatform): AudioPathProfile {
  if (platform === 'win32') {
    return {
      primary: 'electron-display-loopback',
      fallback: ['mediarecorder'],
      notes:
        'Use Chromium display-media loopback for Windows speaker audio. Keep the stream alive, capture audio only, and let the main process grant loopback.',
    };
  }
  if (platform === 'darwin') {
    return {
      primary: 'ffmpeg-blackhole',
      fallback: ['mediarecorder'],
      notes:
        'Use a virtual cable such as BlackHole or Loopback. Route system output through the cable, then capture it as a named input.',
    };
  }
  if (platform === 'linux') {
    return {
      primary: 'ffmpeg-pulse-stream',
      fallback: ['pw-record'],
      notes:
        'Prefer sink monitor capture on PipeWire / Pulse. Keep the sink monitor explicit and fall back to pw-record only when needed.',
    };
  }
  return {
    primary: 'none',
    fallback: [],
    notes: 'Unsupported platform.',
  };
}

function micPath(platform: AudioCapturePlatform): AudioPathProfile {
  if (platform === 'win32') {
    return {
      primary: 'mediarecorder',
      fallback: ['native-module'],
      notes:
        'Use browser mic capture or a native source if available. Keep mic and system audio separate so either stream can fail independently.',
    };
  }
  if (platform === 'darwin') {
    return {
      primary: 'mediarecorder',
      fallback: ['ffmpeg-blackhole'],
      notes:
        'Use browser mic capture for the microphone and reserve the virtual cable only for system audio.',
    };
  }
  if (platform === 'linux') {
    return {
      primary: 'ffmpeg-pulse-stream',
      fallback: ['pw-record', 'mediarecorder'],
      notes:
        'Prefer direct Pulse / PipeWire device capture for the mic, then fall back to browser capture if needed.',
    };
  }
  return {
    primary: 'none',
    fallback: [],
    notes: 'Unsupported platform.',
  };
}

export function getAudioCaptureProfile(
  platform: string | NodeJS.Platform | undefined = process.platform,
): AudioCaptureProfile {
  const p = detectPlatform(platform);
  const system = systemPath(p);
  const mic = micPath(p);

  const warnings = [
    p === 'win32'
      ? 'Windows audio capture should stay on the display-media loopback path. If audio is still silent, the app is likely getting a mute-only track or the speakers are not playing to the default output.'
      : '',
    p === 'darwin'
      ? 'macOS system audio needs a virtual cable. Without BlackHole / Loopback, the system path cannot hear meeting audio.'
      : '',
    p === 'linux'
      ? 'Linux loopback must target a real sink monitor. Capturing the mic by accident will look like working audio with empty transcripts.'
      : '',
  ].filter(Boolean);

  return {
    platform: p,
    system,
    mic,
    runtime: RUNTIME,
    deviceHints: {
      preferSystemMonitorOnLinux: p === 'linux',
      preferVirtualCableOnMac: p === 'darwin',
      preferLoopbackOnWindows: p === 'win32',
    },
    summary:
      p === 'win32'
        ? 'Windows: Chromium loopback for system audio, browser mic capture for the microphone, 16 kHz mono chunks, and short silent-aware polling.'
        : p === 'darwin'
          ? 'macOS: BlackHole / virtual cable for system audio, browser mic capture, and fixed 16 kHz mono chunks.'
          : p === 'linux'
            ? 'Linux: Pulse / PipeWire sink monitor streaming for system audio, native mic capture where possible, and 250 ms Whisper-friendly chunks.'
            : 'Unsupported platform.',
    warnings,
  };
}

export function describeAudioCaptureProfile(
  profile: AudioCaptureProfile,
): string[] {
  return [
    `System audio: ${profile.system.primary}${profile.system.fallback.length ? ` -> ${profile.system.fallback.join(' -> ')}` : ''}`,
    `Mic audio: ${profile.mic.primary}${profile.mic.fallback.length ? ` -> ${profile.mic.fallback.join(' -> ')}` : ''}`,
    `Runtime: ${profile.runtime.sampleRate} Hz, ${profile.runtime.channels} channel, ${profile.runtime.chunkMs} ms chunks`,
    profile.system.notes,
    profile.mic.notes,
  ];
}
