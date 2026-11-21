/**
 * Memory store — Architecture v2, §15 / Phase 5.
 *
 * The store is a thin, tested surface over records; the *driver* that persists
 * them is a separate concern because the runtime cannot agree on one:
 *
 * - Electron 34 bundles Node 20.19, which has **no** `node:sqlite`
 *   (probed on the test box: `ERR_UNKNOWN_BUILTIN_MODULE`), while the system
 *   Node 24 does. So the built-in path is unavailable in the app today.
 * - A native `better-sqlite3` needs a per-ABI rebuild plus asarUnpack on every
 *   OS — the same class of bug as the packaged Whisper failures (FIXES.md F/G).
 * - A WASM build (`sql.js`) loads anywhere but must persist by rewriting a file.
 *
 * Keeping the in-memory driver first means the store API, the upsert semantics
 * and the ranking are settled and tested before any of those is chosen, and the
 * migration can be replayed against a real store in the bench and dry run.
 */

import {
  rankMemories,
  type MemoryRankHit,
  type MemoryRankOptions,
} from '../../../shared/policy/memoryRanking.ts';
import type { MemoryKind, MemoryRecord } from '../../../shared/policy/memoryMigration.ts';
import type { MigrationPlan } from '../../../shared/policy/memoryMigration.ts';

export type UpsertResult = { added: number; updated: number };

export type MemoryStore = {
  /** Idempotent by `id`: the same record twice updates rather than duplicates. */
  upsert(records: ReadonlyArray<MemoryRecord>): UpsertResult;
  get(id: string): MemoryRecord | undefined;
  remove(id: string): boolean;
  all(kind?: MemoryKind): MemoryRecord[];
  count(): number;
  search(query: string, options?: MemoryRankOptions): Array<MemoryRankHit<MemoryRecord>>;
};

/** Apply a planned migration to any store. Safe to re-run: the plan's ids are stable. */
export function applyMigration(store: MemoryStore, plan: MigrationPlan): UpsertResult {
  return store.upsert(plan.records);
}

/** In-memory driver: the default for tests, the bench and the dry run. */
export function createMemoryStore(seed: ReadonlyArray<MemoryRecord> = []): MemoryStore {
  const records = new Map<string, MemoryRecord>();
  for (const record of seed) records.set(record.id, record);

  return {
    upsert(incoming) {
      let added = 0;
      let updated = 0;
      for (const record of incoming) {
        if (!record?.id) continue;
        if (records.has(record.id)) updated += 1;
        else added += 1;
        records.set(record.id, record);
      }
      return { added, updated };
    },

    get(id) {
      return records.get(id);
    },

    remove(id) {
      return records.delete(id);
    },

    all(kind) {
      const list = [...records.values()];
      const filtered = kind ? list.filter((record) => record.kind === kind) : list;
      return filtered.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    },

    count() {
      return records.size;
    },

    search(query, options) {
      return rankMemories([...records.values()], query, options);
    },
  };
}
