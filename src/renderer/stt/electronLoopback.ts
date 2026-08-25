/**
 * Windows (and Chromium) system-audio loopback via Electron display-media.
 *
 * Official path: main sets setDisplayMediaRequestHandler({ audio: 'loopback' }),
 * renderer calls getDisplayMedia({ audio: true, video: true }), then drops video.
 * See docs/CAPTURE-STRATEGY.md — mainline ffmpeg has no WASAPI input.
 *
 * MediaRecorder emits webm/opus; we ALWAYS convert to 16 kHz mono WAV for Local Whisper.
 */

import { recordingToWavBase64 } from './audioWav';

export type ElectronLoopbackResult = {
  ok: boolean;
  base64?: string;
  mimeType?: string;
  error?: string;
  silent?: boolean;
  /** Max short-window RMS measured on the raw loopback TRACK during capture. */
  trackLevel?: number;
  /** RMS computed from the converted WAV (post MediaRecorder/decode). */
  wavRms?: number;
};

let sharedStream: MediaStream | null = null;
let dummyVideo: HTMLVideoElement | null = null;

const isDev = typeof process !== 'undefined' && process.env['OSMOS_DEV'] === '1';
const logger = {
  log: (...args: any[]) => {
    console.log(...args);
    if (isDev) void window.osmos.log?.('log', ...args);
  },
  warn: (...args: any[]) => {
    console.warn(...args);
    if (isDev) void window.osmos.log?.('warn', ...args);
  },
  error: (...args: any[]) => {
    console.error(...args);
    if (isDev) void window.osmos.log?.('error', ...args);
  }
};

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return 'audio/webm';
}

function streamIsLive(stream: MediaStream | null): boolean {
  return Boolean(stream?.getAudioTracks().some((t) => t.readyState === 'live'));
}

function rmsFromWavBase64(base64: string): number {
  try {
    const bin = atob(base64);
    if (bin.length < 48) return 0;
    let sum = 0;
    let n = 0;
    for (let i = 44; i + 1 < bin.length; i += 2) {
      const lo = bin.charCodeAt(i);
      const hi = bin.charCodeAt(i + 1);
      let s = lo | (hi << 8);
      if (s >= 0x8000) s -= 0x10000;
      const f = s / 32768;
      sum += f * f;
      n += 1;
    }
    return n ? Math.sqrt(sum / n) : 0;
  } catch {
    return 0;
  }
}

async function openLoopbackStream(): Promise<MediaStream> {
  logger.log('[electronLoopback] Enabling main-process loopback audio...');
  await window.osmos.enableLoopbackAudio?.();
  try {
    logger.log('[electronLoopback] Calling navigator.mediaDevices.getDisplayMedia...');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Voice DSP (NS/AGC) on the loopback pin can flatten music/system audio
      // to digital silence on some Windows audio stacks — always opt out.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: {
        width: 4,
        height: 4,
        frameRate: 1,
      },
    });
    logger.log('[electronLoopback] Stream obtained. Tracks:', stream.getTracks().map(t => `${t.kind}:${t.label} (live=${t.readyState === 'live'})`));

    if (stream.getAudioTracks().length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error(
        'No system audio track. Click ⚡ Smart once (user gesture), play sound on speakers, retry.',
      );
    }

    // Keep the video track active and flowing by playing it in a hidden video element
    if (!dummyVideo) {
      logger.log('[electronLoopback] Creating dummy video element to keep capture session active...');
      dummyVideo = document.createElement('video');
      dummyVideo.id = 'osmos-loopback-video-hack';
      dummyVideo.muted = true;
      dummyVideo.autoplay = true;
      dummyVideo.style.position = 'fixed';
      dummyVideo.style.top = '-100px';
      dummyVideo.style.left = '-100px';
      dummyVideo.style.width = '4px';
      dummyVideo.style.height = '4px';
      dummyVideo.style.opacity = '0.001';
      dummyVideo.style.pointerEvents = 'none';
      document.body.appendChild(dummyVideo);
    }
    dummyVideo.srcObject = stream;
    logger.log('[electronLoopback] Playing video hack...');
    await dummyVideo.play().catch(e => {
      logger.warn('[electronLoopback] Failed to play dummy video element:', e);
    });

    stream.addEventListener('inactive', () => {
      logger.log('[electronLoopback] Stream became inactive');
      sharedStream = null;
      void window.osmos.disableLoopbackAudio?.().catch(() => undefined);
    });
    return stream;
  } catch (err) {
    logger.error('[electronLoopback] getDisplayMedia error:', err);
    void window.osmos.disableLoopbackAudio?.().catch(() => undefined);
    throw err;
  }
}

/** Keep one live loopback stream across Smart chunks. */
export async function ensureElectronLoopbackStream(): Promise<MediaStream> {
  if (streamIsLive(sharedStream)) return sharedStream!;
  stopElectronLoopbackStream();
  sharedStream = await openLoopbackStream();
  sharedStream.getAudioTracks().forEach((t) => {
    t.addEventListener('ended', () => {
      logger.log('[electronLoopback] Audio track ended');
      if (sharedStream === null) return;
      sharedStream = null;
    });
  });
  return sharedStream;
}

export function stopElectronLoopbackStream() {
  logger.log('[electronLoopback] Stopping electron loopback stream...');
  if (dummyVideo) {
    try {
      dummyVideo.srcObject = null;
      dummyVideo.remove();
    } catch (e) {
      logger.warn('[electronLoopback] Failed to clean up dummy video element:', e);
    }
    dummyVideo = null;
  }
  if (!sharedStream) return;
  for (const t of sharedStream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
  sharedStream = null;
  void window.osmos.disableLoopbackAudio?.().catch(() => undefined);
}

/** Capture system/loopback audio for durationMs → 16 kHz mono WAV for Whisper. */
export async function captureElectronLoopback(
  durationMs = 5_000,
): Promise<ElectronLoopbackResult> {
  let stream: MediaStream;
  try {
    stream = await ensureElectronLoopbackStream();
  } catch (e) {
    void window.osmos.disableLoopbackAudio?.().catch(() => undefined);
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Windows loopback capture failed',
    };
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    return {
      ok: false,
      error: 'Windows loopback stream had no audio track. Click Smart once, then play audio on speakers and retry.',
    };
  }
  logger.log('[electronLoopback] Setting up MediaRecorder with audio-only stream...');
  const audioOnlyStream = new MediaStream(audioTracks);
  const mimeType = pickMimeType();
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(audioOnlyStream, { mimeType });
  } catch {
    recorder = new MediaRecorder(audioOnlyStream);
  }

  // Ground-truth level straight off the track (bypasses recorder/decoder):
  // distinguishes "OS delivered silence" from "our conversion lost it".
  let ctxRef: AudioContext | null = null;
  let srcRef: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let pollTimer: number | null = null;
  let trackLevel = 0;

  return new Promise((resolve) => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef = new Ctx();
      srcRef = ctxRef.createMediaStreamSource(audioOnlyStream);
      analyser = ctxRef.createAnalyser();
      analyser.fftSize = 1024;
      srcRef.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      pollTimer = window.setInterval(() => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > trackLevel) trackLevel = rms;
      }, 80);
    } catch (e) {
      logger.warn('[electronLoopback] Track analyser unavailable:', e);
    }

    const finish = (result: ElectronLoopbackResult) => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      try {
        srcRef?.disconnect();
      } catch {
        /* ignore */
      }
      void ctxRef?.close().catch(() => undefined);
      resolve({ ...result, trackLevel: Number(trackLevel.toFixed(5)) });
    };

    const ms = Math.max(800, durationMs);
    const timer = setTimeout(() => {
      try {
        if (recorder.state === 'recording') {
          logger.log('[electronLoopback] Duration reached, stopping MediaRecorder...');
          recorder.stop();
        }
      } catch {
        /* ignore */
      }
    }, ms);

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };
    recorder.onerror = (e) => {
      logger.error('[electronLoopback] MediaRecorder error event:', e);
      clearTimeout(timer);
      finish({ ok: false, error: 'MediaRecorder failed during Windows loopback capture' });
    };
    recorder.onstop = async () => {
      clearTimeout(timer);
      try {
        const webm = new Blob(chunks, { type: recorder.mimeType || mimeType });
        logger.log('[electronLoopback] Recorded WebM blob size:', webm.size);
        if (webm.size < 256) {
          logger.log('[electronLoopback] Empty recording — trackLevel:', trackLevel);
          finish({ ok: true, base64: '', mimeType: 'audio/wav', silent: true });
          return;
        }
        const wav = await recordingToWavBase64(webm);
        const rms = rmsFromWavBase64(wav.base64);
        logger.log(
          '[electronLoopback] Captured WAV rms:', rms,
          '| trackLevel:', trackLevel,
        );
        finish({
          ok: true,
          base64: wav.base64,
          mimeType: 'audio/wav',
          silent: rms < 0.006,
          wavRms: Number(rms.toFixed(5)),
        });
      } catch (e) {
        logger.error('[electronLoopback] Failed during post-processing:', e);
        finish({
          ok: false,
          error:
            e instanceof Error
              ? `Loopback→WAV failed: ${e.message}`
              : 'Failed to encode loopback audio as WAV',
        });
      }
    };

    try {
      logger.log('[electronLoopback] Starting MediaRecorder...');
      recorder.start(250);
    } catch (e) {
      clearTimeout(timer);
      logger.error('[electronLoopback] Failed to start MediaRecorder:', e);
      finish({
        ok: false,
        error: e instanceof Error ? e.message : 'Failed to start loopback recorder',
      });
    }
  });
}

export async function isWindowsPlatform(): Promise<boolean> {
  try {
    const info = await window.osmos.getInfo();
    return info.platform === 'win32';
  } catch {
    return navigator.platform?.toLowerCase().includes('win') ?? false;
  }
}
