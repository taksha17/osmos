/**
 * Rolling screen-snapshot window — Architecture v2, §12 / Phase 4.
 *
 * The window itself is pure and unit-tested (`shared/policy/snapshotHistory.ts`);
 * this is the process-wide slot plus the convenience the screen engine calls after
 * every successful OCR. Text only: images stay in `screenImageCache.ts`, which
 * keeps exactly one grab.
 */

import {
  recentSnapshots,
  rememberSnapshot,
  type SnapshotMemoryEntry,
} from '../../shared/policy/snapshotHistory.js';

let memory: SnapshotMemoryEntry[] = [];

/** Record an OCR'd screen. Unchanged screens collapse into one entry. */
export function rememberScreenSnapshot(input: { text: string; at: number }): void {
  memory = rememberSnapshot(memory, { text: input.text, at: input.at });
}

/** Earlier snapshots for the request being answered, oldest first. */
export function recentScreenSnapshots(
  options: { now?: number; beforeAt?: number; limit?: number } = {},
): SnapshotMemoryEntry[] {
  return recentSnapshots(memory, {
    now: options.now ?? Date.now(),
    ...(options.beforeAt === undefined ? {} : { beforeAt: options.beforeAt }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

/** Forget the window (privacy switches, tests). */
export function clearScreenSnapshots(): void {
  memory = [];
}
