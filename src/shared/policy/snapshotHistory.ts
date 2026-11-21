/**
 * Rolling screen-snapshot memory — Architecture v2, §12 / Phase 4.
 *
 * A coding session asks follow-ups about the same screen ("and now?", "why is it
 * still failing?"). The current snapshot alone cannot answer those, so main keeps
 * the last few, and the packet carries them as clipped context.
 *
 * Pure: bounded by count and age, de-duplicated by content, ordered oldest first.
 * No clock, no I/O — the caller passes `now` and the timestamp of the snapshot
 * being answered.
 */

import { classifySnapshot, type SnapshotKind } from './screenSnapshot.ts';

export type SnapshotMemoryEntry = {
  id: string;
  kind: SnapshotKind;
  text: string;
  at: number;
};

export const SNAPSHOT_MEMORY_DEFAULTS = {
  /** §12 keeps the rolling window short: older screens are usually noise. */
  maxEntries: 3,
  maxAgeMs: 120_000,
};

/** An entry must be at least this much older than the current snapshot to count as history. */
export const SNAPSHOT_MIN_GAP_MS = 1_000;

export type SnapshotMemoryLimits = { maxEntries?: number; maxAgeMs?: number };

/**
 * Add a snapshot to the window. Identical text with the same kind replaces the
 * earlier entry instead of stacking — a screen that did not change is not a new
 * context item.
 */
export function rememberSnapshot(
  memory: readonly SnapshotMemoryEntry[],
  input: { id?: string; text: string; at: number; kind?: SnapshotKind },
  limits: SnapshotMemoryLimits = {},
): SnapshotMemoryEntry[] {
  const text = String(input.text ?? '').trim();
  const at = Number(input.at);
  if (!text || !Number.isFinite(at)) return [...memory];

  const maxEntries = Math.max(1, limits.maxEntries ?? SNAPSHOT_MEMORY_DEFAULTS.maxEntries);
  const entry: SnapshotMemoryEntry = {
    id: input.id ?? `snapshot-${at}`,
    kind: input.kind ?? classifySnapshot(text).kind,
    text,
    at,
  };

  const kept = memory.filter((item) => !(item.text === entry.text && item.kind === entry.kind));
  return [...kept, entry].sort((a, b) => a.at - b.at).slice(-maxEntries);
}

/**
 * The history to send with a request: fresh enough, strictly older than the
 * snapshot being answered, oldest first so the prompt reads chronologically.
 */
export function recentSnapshots(
  memory: readonly SnapshotMemoryEntry[],
  options: { now: number; beforeAt?: number; maxAgeMs?: number; limit?: number },
): SnapshotMemoryEntry[] {
  const now = Number(options.now);
  if (!Number.isFinite(now)) return [];
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_MEMORY_DEFAULTS.maxAgeMs;
  const limit = Math.max(0, options.limit ?? SNAPSHOT_MEMORY_DEFAULTS.maxEntries);

  return memory
    .filter((entry) => Number.isFinite(entry.at))
    .filter((entry) => Math.abs(now - entry.at) <= maxAgeMs)
    .filter(
      (entry) =>
        options.beforeAt === undefined || entry.at < options.beforeAt - SNAPSHOT_MIN_GAP_MS,
    )
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}
