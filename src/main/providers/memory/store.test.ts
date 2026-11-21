import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigration, createMemoryStore } from './store.ts';
import { planMemoryMigration } from '../../../shared/policy/memoryMigration.ts';
import type { MemoryRecord } from '../../../shared/policy/memoryMigration.ts';
import type { ChatSession } from '../../../shared/types.ts';

const NOW = 1_700_000_000_000;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: 'm1', kind: 'message', at: NOW, text: 'hello world', ...overrides };
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

test('upsert is idempotent by id and reports what it did', () => {
  const store = createMemoryStore();
  assert.deepEqual(store.upsert([record()]), { added: 1, updated: 0 });
  assert.deepEqual(store.upsert([record()]), { added: 0, updated: 1 });
  assert.equal(store.count(), 1);
});

test('upsert replaces the record, it does not merge stale fields', () => {
  const store = createMemoryStore([record({ title: 'old', text: 'old text' })]);
  store.upsert([record({ text: 'new text' })]);
  assert.equal(store.get('m1')!.text, 'new text');
  assert.equal(store.get('m1')!.title, undefined);
});

test('records without an id are ignored rather than stored under undefined', () => {
  const store = createMemoryStore();
  assert.deepEqual(store.upsert([{ ...record(), id: '' }]), { added: 0, updated: 0 });
  assert.equal(store.count(), 0);
});

test('all() filters by kind and stays in chronological order', () => {
  const store = createMemoryStore([
    record({ id: 'late', at: NOW }),
    record({ id: 'early', at: NOW - 10, kind: 'question' }),
    record({ id: 'mid', at: NOW - 5 }),
  ]);
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['early', 'mid', 'late'],
  );
  assert.deepEqual(
    store.all('question').map((item) => item.id),
    ['early'],
  );
});

test('remove reports whether it removed anything', () => {
  const store = createMemoryStore([record()]);
  assert.equal(store.remove('m1'), true);
  assert.equal(store.remove('m1'), false);
  assert.equal(store.count(), 0);
});

test('applying the same migration twice does not duplicate records', () => {
  const plan = planMemoryMigration({ sessions: [session('s1', 'Why this company?')], now: NOW });
  const store = createMemoryStore();

  assert.deepEqual(applyMigration(store, plan), { added: 3, updated: 0 });
  assert.deepEqual(applyMigration(store, plan), { added: 0, updated: 3 });
  assert.equal(store.count(), 3);
});

test('a migrated session is findable by what was asked in it', () => {
  const plan = planMemoryMigration({
    sessions: [session('s1', 'Tell me about the Kubernetes migration')],
    now: NOW,
  });
  const store = createMemoryStore();
  applyMigration(store, plan);

  const hits = store.search('kubernetes migration', { now: NOW, limit: 3 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.record.sessionId, 's1');
  assert.ok(hits[0]!.record.text.includes('Kubernetes'));
});

test('search on an empty store is empty, not an error', () => {
  assert.deepEqual(createMemoryStore().search('anything', { now: NOW }), []);
});
