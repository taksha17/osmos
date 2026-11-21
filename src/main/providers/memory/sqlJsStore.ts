/**
 * Persistent memory store — Architecture v2, §15 / Phase 5.
 *
 * `sql.js` is SQLite compiled to WASM: it loads in the Electron main process
 * without a native rebuild, which matters because Electron 34 runs Node 20.19
 * where `node:sqlite` does not exist (probed on the test box) and a native
 * `better-sqlite3` would need a per-ABI rebuild plus asarUnpack everywhere.
 *
 * WASM SQLite is in-memory, so durability is explicit: every write batch is
 * exported to `memory.sqlite` through a temp file and a rename, which cannot
 * leave a half-written database behind. The record set is also cached in a Map
 * for ranking, which keeps `search` synchronous like the rest of the store.
 *
 * Schema is versioned in `meta` rather than `PRAGMA user_version` so a future
 * driver can read the version without trusting a pragma convention.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import type { SqlJsStatic, Database } from 'sql.js';
import { rankMemories, type MemoryRankHit, type MemoryRankOptions } from '../../../shared/policy/memoryRanking.ts';
import type { MemoryKind, MemoryRecord } from '../../../shared/policy/memoryMigration.ts';
import type { MemoryStore, UpsertResult } from './store.ts';

export const MEMORY_SCHEMA_VERSION = '1';
const SQLITE_HEADER = 'SQLite format 3\0';
export const MEMORY_DB_FILE = 'memory.sqlite';

export type SqlJsStoreOptions = {
  filePath: string;
  /** Fail instead of creating a new database when the file is missing. */
  mustExist?: boolean;
};

export type PersistentMemoryStore = MemoryStore & {
  readonly filePath: string;
  /** Export the current state to disk (atomically). */
  flush(): void;
  /** Flush and release the database handle. */
  close(): void;
};

type Row = {
  id: string;
  kind: string;
  at: number;
  text: string;
  session_id: string | null;
  profile_id: string | null;
  title: string | null;
  meta: string | null;
};

function toRecord(row: Row): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    kind: row.kind as MemoryKind,
    at: Number(row.at) || 0,
    text: row.text ?? '',
  };
  if (row.session_id) record.sessionId = row.session_id;
  if (row.profile_id) record.profileId = row.profile_id;
  if (row.title) record.title = row.title;
  if (row.meta) {
    try {
      record.meta = JSON.parse(row.meta) as Record<string, string | number | boolean>;
    } catch {
      // A corrupt meta blob must not hide the record itself.
    }
  }
  return record;
}

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      text TEXT NOT NULL,
      session_id TEXT,
      profile_id TEXT,
      title TEXT,
      meta TEXT
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_records_at ON records (at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_records_kind ON records (kind)');
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [
    'schema_version',
    MEMORY_SCHEMA_VERSION,
  ]);
}

function readRows(db: Database): Row[] {
  const result = db.exec(
    'SELECT id, kind, at, text, session_id, profile_id, title, meta FROM records',
  );
  if (!result.length) return [];
  const { columns, values } = result[0]!;
  const index = new Map(columns.map((column, position) => [column, position]));
  return values.map((row) => ({
    id: String(row[index.get('id')!] ?? ''),
    kind: String(row[index.get('kind')!] ?? 'unknown'),
    at: Number(row[index.get('at')!] ?? 0),
    text: String(row[index.get('text')!] ?? ''),
    session_id: (row[index.get('session_id')!] as string | null) ?? null,
    profile_id: (row[index.get('profile_id')!] as string | null) ?? null,
    title: (row[index.get('title')!] as string | null) ?? null,
    meta: (row[index.get('meta')!] as string | null) ?? null,
  }));
}

/**
 * Open (or create) the database at `filePath`.
 *
 * Rejects with a message naming the file when an existing database cannot be
 * read — silently starting empty over a user's memory would be data loss.
 */
/**
 * Resolve the WASM binary by module resolution, not by `__dirname`.
 *
 * Tests bundle this file with esbuild into `.test-build/`, where the emscripten
 * glue's own relative lookup would point at the wrong directory; a packaged
 * Electron build has the mirror problem inside `app.asar`. `require.resolve`
 * works in both, and Electron's patched `fs` can read from the asar.
 */
function resolveWasm(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    return undefined;
  }
}

export async function openSqlJsStore(options: SqlJsStoreOptions): Promise<PersistentMemoryStore> {
  const filePath = path.resolve(options.filePath);
  const wasm = resolveWasm();
  const SQL: SqlJsStatic = await initSqlJs(wasm ? { locateFile: () => wasm } : undefined);

  const exists = fs.existsSync(filePath);
  if (!exists && options.mustExist) {
    throw new Error(`memory database not found: ${filePath}`);
  }

  let db: Database;
  if (exists) {
    const bytes = fs.readFileSync(filePath);
    // SQLite itself only complains at the first statement, which would surface as
    // a confusing error far from the file. Check the header here so the message
    // names the file the user can actually act on.
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('utf8') !== SQLITE_HEADER) {
      throw new Error(`memory database is not a SQLite file (${filePath})`);
    }
    try {
      db = new SQL.Database(bytes);
    } catch (error) {
      throw new Error(
        `memory database is not readable (${filePath}): ${(error as Error).message}`,
      );
    }
  } else {
    db = new SQL.Database();
  }

  try {
    createSchema(db);
  } catch (error) {
    throw new Error(
      `memory database cannot be opened (${filePath}): ${(error as Error).message}`,
    );
  }

  const records = new Map<string, MemoryRecord>();
  for (const row of readRows(db)) records.set(row.id, toRecord(row));
  let closed = false;

  const flush = (): void => {
    if (closed) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, Buffer.from(db.export()));
    fs.renameSync(temp, filePath);
  };

  return {
    filePath,

    upsert(incoming: ReadonlyArray<MemoryRecord>): UpsertResult {
      if (closed) throw new Error('memory store is closed');
      let added = 0;
      let updated = 0;
      db.run('BEGIN');
      try {
        for (const record of incoming) {
          if (!record?.id) continue;
          if (records.has(record.id)) updated += 1;
          else added += 1;
          records.set(record.id, record);
          db.run(
            `INSERT INTO records (id, kind, at, text, session_id, profile_id, title, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, at = excluded.at, text = excluded.text,
               session_id = excluded.session_id, profile_id = excluded.profile_id,
               title = excluded.title, meta = excluded.meta`,
            [
              record.id,
              record.kind,
              record.at,
              record.text,
              record.sessionId ?? null,
              record.profileId ?? null,
              record.title ?? null,
              record.meta ? JSON.stringify(record.meta) : null,
            ],
          );
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
      if (added || updated) flush();
      return { added, updated };
    },

    get(id) {
      return records.get(id);
    },

    remove(id) {
      if (closed) throw new Error('memory store is closed');
      if (!records.delete(id)) return false;
      db.run('DELETE FROM records WHERE id = ?', [id]);
      flush();
      return true;
    },

    all(kind?: MemoryKind) {
      const list = [...records.values()];
      const filtered = kind ? list.filter((record) => record.kind === kind) : list;
      return filtered.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    },

    count() {
      return records.size;
    },

    search(query: string, rankOptions?: MemoryRankOptions): Array<MemoryRankHit<MemoryRecord>> {
      return rankMemories([...records.values()], query, rankOptions);
    },

    flush,

    close() {
      if (closed) return;
      flush();
      closed = true;
      db.close();
    },
  };
}

/** Default on-disk location, kept next to `chat-history.json` in userData. */
export function memoryDbPath(userDataDir: string): string {
  return path.join(userDataDir, MEMORY_DB_FILE);
}
