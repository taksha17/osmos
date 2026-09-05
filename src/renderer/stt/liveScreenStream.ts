/**
 * Continuous screen reading via ONE long-lived getDisplayMedia session.
 *
 * This is the only flash-free, prompt-once way to read the screen on GNOME
 * Wayland: the xdg ScreenCast portal asks once (user picks a screen or the
 * meeting window), then we silently pull frames from a hidden <video>.
 * gnome-screenshot / the Screenshot portal flash the screen on every shot, so
 * they must never be looped — see AGENTS.md "Screen reading".
 *
 * Per tick we:
 *   1. draw the video into a tiny grayscale thumbnail and compare it with the
 *      previous one (real pixel diff — unchanged slides cost ~0 ms, no OCR);
 *   2. when the frame changed, emit a downscaled JPEG and AWAIT the caller's
 *      handler (OCR in main). No new frame is sampled while OCR is in flight.
 *
 * Must be started from a user gesture (click) — Chromium requires transient
 * activation for getDisplayMedia.
 */

export type LiveScreenFrame = {
  dataUrl: string;
  at: number;
};

/** Latest sampled frame, module-scoped so 📷 one-shot can reuse the live
 * stream instead of triggering another portal prompt / shutter flash. */
let latestFrame: LiveScreenFrame | null = null;
let activeStop: (() => void) | null = null;

export function getLatestLiveFrame(): LiveScreenFrame | null {
  return latestFrame;
}

export function isLiveScreenActive(): boolean {
  return activeStop !== null;
}

export function stopLiveScreenStream(): void {
  activeStop?.();
}

type LiveScreenStreamOpts = {
  /** Poll interval. Diffing is cheap, so 1500–2500 ms is fine. */
  intervalMs?: number;
  /** Max JPEG width sent to OCR. ~2000 keeps small UI text legible. */
  maxWidth?: number;
  /** Mean absolute luminance diff (0–255) above which a frame counts as changed. */
  changeThreshold?: number;
  /** Awaited — the next changed frame is not emitted until this resolves. */
  onFrame: (frame: LiveScreenFrame) => Promise<void> | void;
  onStatus?: (text: string) => void;
  onError: (error: string) => void;
};

const THUMB_W = 48;
const THUMB_H = 27;

export async function startLiveScreenStream(
  opts: LiveScreenStreamOpts,
): Promise<{ stop: () => void; label: string }> {
  if (activeStop) activeStop();

  const intervalMs = Math.max(1000, Math.min(10_000, opts.intervalMs ?? 2000));
  const maxWidth = opts.maxWidth ?? 2000;
  const changeThreshold = opts.changeThreshold ?? 4;

  // getDisplayMedia first — must run while the click's transient activation is live.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 5, max: 10 } } as MediaTrackConstraints,
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No video track in display stream');
  }
  const label = track.label || 'screen';

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  const full = document.createElement('canvas');
  const fullCtx = full.getContext('2d', { willReadFrequently: false });
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });
  if (!fullCtx || !thumbCtx) throw new Error('No 2d context');

  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let prevLuma: Uint8ClampedArray | null = null;
  let framesSeen = 0;
  let framesOcr = 0;

  const luminance = (): Uint8ClampedArray => {
    thumbCtx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
    const { data } = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H);
    const out = new Uint8ClampedArray(THUMB_W * THUMB_H);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      out[j] = (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
    }
    return out;
  };

  const meanAbsDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / a.length;
  };

  const sample = async () => {
    if (stopped || busy) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    busy = true;
    try {
      const luma = luminance();
      framesSeen++;
      const diff = prevLuma ? meanAbsDiff(luma, prevLuma) : Infinity;
      if (diff < changeThreshold) {
        opts.onStatus?.(`👁 watching ${label} · unchanged`);
        return;
      }
      prevLuma = luma;

      const scale = Math.min(1, maxWidth / video.videoWidth);
      full.width = Math.max(1, Math.round(video.videoWidth * scale));
      full.height = Math.max(1, Math.round(video.videoHeight * scale));
      fullCtx.drawImage(video, 0, 0, full.width, full.height);
      const dataUrl = full.toDataURL('image/jpeg', 0.8);
      latestFrame = { dataUrl, at: Date.now() };
      framesOcr++;
      opts.onStatus?.(`👁 reading ${label}…`);
      await opts.onFrame(latestFrame);
    } catch (e) {
      opts.onError(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (activeStop === stop) activeStop = null;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    video.srcObject = null;
    console.log(`[liveScreen] stopped — frames seen ${framesSeen}, OCR'd ${framesOcr}`);
  };

  track.addEventListener('ended', () => {
    if (stopped) return;
    stop();
    opts.onError('Screen share ended (permission revoked or window closed)');
  });

  activeStop = stop;
  opts.onStatus?.(`👁 watching ${label}`);
  // First sample soon so the user sees it working, then steady interval.
  setTimeout(() => void sample(), 400);
  timer = setInterval(() => void sample(), intervalMs);

  return { stop, label };
}
