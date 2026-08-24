/**
 * Platform capture strategy — single source of truth for Smart listen / screen OCR.
 * Details: docs/CAPTURE-STRATEGY.md
 */

export type CapturePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

export type AudioCaptureBackend =
  | 'electron-display-loopback' // Windows (Chromium WASAPI under the hood)
  | 'ffmpeg-pulse-stream' // Linux continuous
  | 'pw-record' // Linux fallback
  | 'ffmpeg-blackhole' // macOS virtual device
  | 'screencapturekit' // macOS future
  | 'none';

export type ScreenCaptureBackend =
  | 'gdi-powershell' // Windows loop-safe
  | 'screencapture-cli' // macOS loop-safe
  | 'cli-grim-gnome' // Linux loop-safe
  | 'desktop-capturer' // on-demand last resort (may portal on Wayland)
  | 'none';

export type CaptureStrategy = {
  platform: CapturePlatform;
  audio: {
    primary: AudioCaptureBackend;
    fallback: AudioCaptureBackend[];
    notes: string;
  };
  screen: {
    onDemand: ScreenCaptureBackend;
    continuous: ScreenCaptureBackend;
    /** Continuous must never use Wayland portal / desktopCapturer loops. */
    loopSafeOnly: boolean;
    notes: string;
  };
  /** Overlay may gather context continuously; answers only on keybind. */
  answerMode: 'keybind-only' | 'auto-ask-allowed';
};

export function detectCapturePlatform(
  platform: string | NodeJS.Platform | undefined = typeof process !== 'undefined' ? process.platform : undefined,
): CapturePlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'unknown';
}

export function getCaptureStrategy(
  platform: string | NodeJS.Platform | undefined = typeof process !== 'undefined' ? process.platform : undefined,
): CaptureStrategy {
  const p = detectCapturePlatform(platform);

  if (p === 'win32') {
    return {
      platform: p,
      audio: {
        primary: 'electron-display-loopback',
        fallback: [],
        notes:
          'Use session.setDisplayMediaRequestHandler({ audio: "loopback" }) + getDisplayMedia. ffmpeg has no WASAPI input.',
      },
      screen: {
        onDemand: 'gdi-powershell',
        continuous: 'gdi-powershell',
        loopSafeOnly: true,
        notes: 'GDI primary-screen grab is loop-safe; desktopCapturer ok for one-shot only.',
      },
      answerMode: 'keybind-only',
    };
  }

  if (p === 'darwin') {
    return {
      platform: p,
      audio: {
        primary: 'ffmpeg-blackhole',
        fallback: ['screencapturekit'],
        notes: 'BlackHole / Multi-Output Device today; prefer ScreenCaptureKit audio when wired.',
      },
      screen: {
        onDemand: 'screencapture-cli',
        continuous: 'screencapture-cli',
        loopSafeOnly: true,
        notes: 'screencapture -x for continuous; SCK planned.',
      },
      answerMode: 'keybind-only',
    };
  }

  if (p === 'linux') {
    return {
      platform: p,
      audio: {
        primary: 'ffmpeg-pulse-stream',
        fallback: ['pw-record'],
        notes: 'ffmpeg -f pulse on sink *.monitor; never parec on PipeWire.',
      },
      screen: {
        onDemand: 'desktop-capturer',
        continuous: 'cli-grim-gnome',
        loopSafeOnly: true,
        notes: 'Continuous = grim/gnome-screenshot/spectacle/scrot only. Never loop portal.',
      },
      answerMode: 'keybind-only',
    };
  }

  return {
    platform: 'unknown',
    audio: { primary: 'none', fallback: [], notes: 'Unsupported platform' },
    screen: {
      onDemand: 'none',
      continuous: 'none',
      loopSafeOnly: true,
      notes: 'Unsupported platform',
    },
    answerMode: 'keybind-only',
  };
}
