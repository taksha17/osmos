/**
 * Screen image attachment — Architecture v2, §6.4 / Phase 4.
 *
 * The packets carry OCR text; an image is only worth sending when the text is not
 * enough (a code or problem snapshot, §12) and the lane can take one. The grab
 * that produced the OCR is remembered in main, and this module decides whether
 * that grab may travel with the request.
 *
 * Two rules, both about honesty: the image must be recent, and it must be the
 * *same snapshot* the OCR text came from. Pairing a fresh image with yesterday's
 * text would have the model describe something the prompt never showed.
 */

import type { LlmImageInput } from '../contracts/llm.ts';

/** A grabbed screen image older than this is never attached (§12 freshness). */
export const SCREEN_IMAGE_MAX_AGE_MS = 45_000;
/** The OCR text and the image may drift this much before they are not a pair. */
export const SCREEN_IMAGE_MAX_SKEW_MS = 5_000;

export type ScreenGrabRef = {
  /** `data:` URL of the grab (the only form main keeps in memory). */
  dataRef: string;
  /** When the grab was taken, ms epoch. */
  at: number;
  mime?: string;
};

/**
 * The image to attach, or `null` when nothing justifies one.
 *
 * `screenAt` is the timestamp the renderer attached to the OCR text; without it
 * there is no text this image belongs to, so the packet's OCR path is used.
 */
export function freshScreenImage(
  grab: ScreenGrabRef | null | undefined,
  screenAt: number | undefined,
  now: number = Date.now(),
  options: { maxAgeMs?: number; maxSkewMs?: number } = {},
): LlmImageInput | null {
  const dataRef = String(grab?.dataRef ?? '').trim();
  if (!dataRef) return null;
  if (typeof screenAt !== 'number' || !Number.isFinite(screenAt)) return null;

  const at = Number(grab?.at);
  if (!Number.isFinite(at)) return null;

  const maxAgeMs = options.maxAgeMs ?? SCREEN_IMAGE_MAX_AGE_MS;
  const maxSkewMs = options.maxSkewMs ?? SCREEN_IMAGE_MAX_SKEW_MS;

  if (Math.abs(now - at) > maxAgeMs) return null;
  if (Math.abs(at - screenAt) > maxSkewMs) return null;

  return { mime: grab?.mime || 'image/png', dataRef };
}
