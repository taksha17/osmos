/**
 * Memory service — Phase 5 wiring.
 *
 * Owns the process-wide memory store: opens `memory.sqlite` next to the other
 * user data, migrates the legacy JSON the first time it is empty, and answers
 * the chat path's synchronous `memoryHits(query)` calls from the in-memory cache
 * the driver keeps. Retrieval must never be able to break a chat request, so
 * every entry point here degrades to "no memories" instead of throwing.
 *
 * Opened once at app start (`startMemory`), not per request: the WASM database
 * takes a moment to initialise and migration should not run in a chat handler.
 */

import { planMemoryMigration } from '../../shared/policy/memoryMigration.js';
import type { ChatSession } from '../../shared/types.js';
import { memoryDbPath, openSqlJsStore, type PersistentMemoryStore } from '../providers/memory/sqlJsStore.js';
import { applyMigration } from '../providers/memory/store.js';
import { loadHistory } from './history.js';
import { getSettings } from './settingsStore.js';

export type MemoryHit = { id: string; kind: string; at: number; text: string; score: number };

let store: PersistentMemoryStore | null = null;
let opening = false;

function rememberProfiles(): ReturnType<typeof getSettings>['profiles'] {
  try {
    return getSettings().profiles;
  } catch {
    return [];
  }
}

/**
 * Migrate legacy data when the database is empty. Re-running on later launches
 * must not duplicate anything, so this only fires for a fresh store; individual
 * sessions are added afterwards through `rememberSession`.
 */
function migrateLegacy(): void {
  if (!store || store.count() > 0) return;
  const plan = planMemoryMigration({ sessions: loadHistory(), profiles: rememberProfiles() });
  if (plan.records.length === 0) return;
  const result = applyMigration(store, plan);
  console.log(
    `[memory] migrated ${result.added} records${plan.skipped.length ? `, skipped ${plan.skipped.length}` : ''}`,
  );
}

/** Open the store in the background. Safe to call more than once. */
export function startMemory(userDataDir: string): void {
  if (store || opening) return;
  opening = true;
  void (async () => {
    try {
      store = await openSqlJsStore({ filePath: memoryDbPath(userDataDir) });
      migrateLegacy();
      console.log(`[memory] ready: ${store.count()} records`);
    } catch (error) {
      console.error('[memory] unavailable; continuing without retrieval:', error);
    } finally {
      opening = false;
    }
  })();
}

/** Ranked memories for a question, or `[]` before the store is ready. */
export function memoryHits(query: string, limit = 3, now = Date.now()): MemoryHit[] {
  if (!store) return [];
  try {
    return store.search(query, { limit, now }).map((hit) => ({
      id: hit.record.id,
      kind: hit.record.kind,
      at: hit.record.at,
      text: hit.record.text,
      score: hit.score,
    }));
  } catch (error) {
    console.error('[memory] search failed:', error);
    return [];
  }
}

/** Add or update one saved chat session. Idempotent, like the migration. */
export function rememberSession(session: ChatSession): void {
  if (!store) return;
  try {
    applyMigration(store, planMemoryMigration({ sessions: [session] }));
  } catch (error) {
    console.error('[memory] could not remember session:', error);
  }
}

export function memoryStatus(): { ready: boolean; records: number; file: string | null } {
  return { ready: Boolean(store), records: store?.count() ?? 0, file: store?.filePath ?? null };
}

export function closeMemory(): void {
  try {
    store?.close();
  } finally {
    store = null;
  }
}
