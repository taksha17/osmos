import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSqlJsStore } from './sqlJsStore.ts';
import { applyMigration } from './store.ts';
import { planMemoryMigration } from '../../../shared/policy/memoryMigration.ts';
import type { ChatSession } from '../../../shared/types.ts';

const NOW = 1_700_000_000_000;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'osmos-memory-'));
}

function session(id: string, question: string): ChatSession {
  return {
    id,
    mode: 'interview',
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    messages: [
      { role: 'user', content: question, createdAt: NOW - 60_000 },
      { role: 'assistant', content: `answer to ${question}`, createdAt: NOW - 59_000 },
    ],
  };
}

test('records survive close and reopen', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.sqlite');
  const plan = planMemoryMigration({ sessions: [session('s1', 'Kubernetes migration story')], now: NOW });

  const first = await openSqlJsStore({ filePath: file });
  assert.deepEqual(applyMigration(first, plan), { added: 3, updated: 0 });
  first.close();

  assert.ok(fs.existsSync(file), 'the database file should exist after close');

  const second = await openSqlJsStore({ filePath: file, mustExist: true });
  assert.equal(second.count(), 3);
  const hits = second.search('kubernetes migration', { now: NOW });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.record.sessionId, 's1');
  second.close();
});

test('a metadata field round-trips through the database, not just the cache', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.sqlite');
  const plan = planMemoryMigration({ sessions: [session('s1', 'Why this company?')], now: NOW });

  const first = await openSqlJsStore({ filePath: file });
  applyMigration(first, plan);
  const original = first.get('message:s1:0')!;
  first.close();

  const second = await openSqlJsStore({ filePath: file, mustExist: true });
  const restored = second.get('message:s1:0')!;
  assert.deepEqual(restored.meta, original.meta);
  assert.equal(restored.title, original.title);
  second.close();
});

test('upserting the same migration twice keeps one row per record', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.sqlite');
  const plan = planMemoryMigration({ sessions: [session('s1', 'Tell me about yourself')], now: NOW });

  const first = await openSqlJsStore({ filePath: file });
  applyMigration(first, plan);
  assert.deepEqual(applyMigration(first, plan), { added: 0, updated: 3 });
  first.close();

  const second = await openSqlJsStore({ filePath: file, mustExist: true });
  assert.equal(second.count(), 3, 'replaying migration must not duplicate rows');
  second.close();
});

test('removal is durable', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.sqlite');
  const plan = planMemoryMigration({ sessions: [session('s1', 'Question')], now: NOW });

  const first = await openSqlJsStore({ filePath: file });
  applyMigration(first, plan);
  assert.equal(first.remove('message:s1:1'), true);
  assert.equal(first.remove('message:s1:1'), false);
  first.close();

  const second = await openSqlJsStore({ filePath: file, mustExist: true });
  assert.equal(second.count(), 2);
  assert.equal(second.get('message:s1:1'), undefined);
  second.close();
});

test('writing after close throws instead of silently losing the write', async () => {
  const dir = tempDir();
  const store = await openSqlJsStore({ filePath: path.join(dir, 'memory.sqlite') });
  store.close();
  assert.throws(() => store.upsert([{ id: 'x', kind: 'message', at: 1, text: 'x' }]), /closed/);
});

test('mustExist refuses to invent an empty database', async () => {
  const dir = tempDir();
  await assert.rejects(
    () => openSqlJsStore({ filePath: path.join(dir, 'missing.sqlite'), mustExist: true }),
    /not found/,
  );
});

test('a corrupt file is reported with its path, not read as empty memory', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'memory.sqlite');
  fs.writeFileSync(file, Buffer.from('this is not a database at all, just text'));
  await assert.rejects(() => openSqlJsStore({ filePath: file }), (error: Error) =>
    error.message.includes(file),
  );
});

test('flush writes atomically and leaves no temp file behind', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'memory.sqlite');
  const store = await openSqlJsStore({ filePath: file });
  store.upsert([{ id: 'x', kind: 'message', at: NOW, text: 'hello' }]);
  store.flush();
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const size = fs.statSync(file).size;
  assert.ok(size > 0, 'the exported database should not be empty');
  store.close();
});
