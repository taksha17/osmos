/**
 * Last silently grabbed screen image — Architecture v2, §6.4.
 *
 * The chat path has always carried OCR text only. To attach the image a code
 * snapshot actually needs, main keeps the bytes of the most recent silent grab:
 * the renderer already receives the OCR text and its timestamp, so nothing has to
 * cross the preload boundary and no screenshot is ever written to disk.
 *
 * Memory only, dropped after `MAX_AGE_MS`, cleared on demand. The freshness rule
 * itself lives in `src/shared/policy/screenImage.ts` and is unit-tested; this file
 * is just the slot.
 */

const MAX_AGE_MS = 60_000;

type StoredGrab = { dataRef: string; at: number; mime: string };

let last: StoredGrab | null = null;

/** Record a grab. Non-image or empty frames are ignored. */
export function rememberScreenGrab(grab: { dataUrl?: string; at?: number }): void {
  const dataRef = String(grab?.dataUrl ?? '').trim();
  if (!dataRef.startsWith('data:image/')) return;
  const mime = /^data:([^;,]+)/.exec(dataRef)?.[1]?.toLowerCase() || 'image/png';
  const at = Number(grab?.at);
  last = { dataRef, at: Number.isFinite(at) ? at : Date.now(), mime };
}

/** The most recent grab, or null once it is older than the retention window. */
export function lastScreenGrab(): StoredGrab | null {
  if (!last) return null;
  if (Date.now() - last.at > MAX_AGE_MS) {
    last = null;
    return null;
  }
  return last;
}

/** Forget the grab (privacy switches, tests). */
export function clearScreenGrab(): void {
  last = null;
}
