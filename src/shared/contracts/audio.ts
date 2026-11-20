/**
 * Audio capture contract — Architecture v2, §5.1.
 *
 * Types only. One backend per channel per OS:
 *   Windows — Chromium/WASAPI loopback
 *   macOS   — ScreenCaptureKit audio (BlackHole fallback)
 *   Linux   — `ffmpeg -f pulse` on a `*.monitor`, `pw-record` fallback
 *
 * Hard rule carried over from v0.6: never `parec` on PipeWire monitors.
 */

export type AudioChannel = 'mic' | 'spk';

/** Runtime profile every backend must deliver (§5.1). */
export type AudioFormat = {
  sampleRate: 16000;
  channels: 1;
  encoding: 's16le';
};

export type AudioFrame = {
  channel: AudioChannel;
  /** Monotonic timestamp of the first sample. */
  tsMs: number;
  pcm: Int16Array;
};

export type AudioBackendStatus = 'idle' | 'starting' | 'active' | 'degraded' | 'stopped';

export interface AudioBackend {
  /** Stable id, e.g. 'linux-ffmpeg-pulse' | 'win-loopback' | 'mac-screencapturekit'. */
  id: string;
  channel: AudioChannel;
  /** Cheap capability probe; must not prompt the user. */
  supported(): Promise<boolean>;
  start(onFrame: (frame: AudioFrame) => void): Promise<void>;
  stop(): Promise<void>;
  status(): AudioBackendStatus;
}
