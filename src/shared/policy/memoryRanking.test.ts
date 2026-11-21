import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMemories } from './memoryRanking.ts';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

type Doc = { id: string; at: number; kind: string; text: string; title?: string };

function doc(id: string, text: string, at = NOW, kind = 'message', title?: string): Doc {
  return { id, at, kind, text, ...(title ? { title } : {}) };
}

test('a lexical hit outranks a non-hit and the hit reports its components', () => {
  const hits = rankMemories(
    [doc('a', 'Tell me about a migration you led'), doc('b', 'Unrelated notes about parking')],
    'migration',
    { now: NOW },
  );

  assert.deepEqual(
    hits.map((hit) => hit.record.id),
    ['a'],
  );
  assert.ok(hits[0]!.parts.lexical > 0);
  assert.ok(hits[0]!.parts.recency > 0.99, 'fresh record keeps a full recency term');
});

test('frequency does not buy rank: coverage does', () => {
  const hits = rankMemories(
    [
      doc('repeats', 'scaling scaling scaling scaling scaling'),
      doc('covers', 'scaling a team through a launch'),
    ],
    'scaling team launch',
    { now: NOW },
  );
  assert.equal(hits[0]!.record.id, 'covers');
});

test('rare tokens weigh more than common ones', () => {
  const common = [1, 2, 3, 4].map((n) => doc(`c${n}`, 'team offsite planning'));
  const hits = rankMemories(
    [...common, doc('rare', 'Kubernetes operator design'), doc('other', 'team meeting notes')],
    'team kubernetes',
    { now: NOW, limit: 10 },
  );
  assert.equal(hits[0]!.record.id, 'rare', 'the rare token should dominate a common one');
});

test('equal matches are decided by recency, then by id', () => {
  const hits = rankMemories(
    [
      doc('old', 'salary expectations', NOW - 30 * DAY),
      doc('new', 'salary expectations', NOW - DAY),
      doc('mid', 'salary expectations', NOW - 10 * DAY),
    ],
    'salary',
    { now: NOW },
  );
  assert.deepEqual(
    hits.map((hit) => hit.record.id),
    ['new', 'mid', 'old'],
  );

  const tied = rankMemories([doc('b', 'same'), doc('a', 'same')], 'same', { now: NOW });
  assert.deepEqual(
    tied.map((hit) => hit.record.id),
    ['a', 'b'],
    'a tie must break deterministically',
  );
});

test('an empty query lists everything, newest first', () => {
  const hits = rankMemories(
    [doc('older', 'anything', NOW - 5 * DAY), doc('newer', 'anything else', NOW)],
    '   ',
    { now: NOW, limit: 10 },
  );
  assert.deepEqual(
    hits.map((hit) => hit.record.id),
    ['newer', 'older'],
  );
});

test('a prepared answer beats a transcript line when both match', () => {
  const hits = rankMemories(
    [doc('msg', 'why acme', NOW, 'message'), doc('q', 'why acme', NOW, 'question')],
    'why acme',
    { now: NOW },
  );
  assert.equal(hits[0]!.record.id, 'q');
});

test('the title is searchable, so a document is findable by name', () => {
  const hits = rankMemories(
    [doc('d1', 'unrelated body text', NOW, 'document', 'Resume 2026')],
    'resume',
    { now: NOW },
  );
  assert.equal(hits[0]!.record.id, 'd1');
});

test('the limit is respected and zero returns nothing', () => {
  const records = Array.from({ length: 9 }, (_, index) => doc(`r${index}`, 'shared word'));
  assert.equal(rankMemories(records, 'shared', { now: NOW, limit: 3 }).length, 3);
  assert.deepEqual(rankMemories(records, 'shared', { now: NOW, limit: 0 }), []);
});

test('no records or no matches yields an empty list instead of throwing', () => {
  assert.deepEqual(rankMemories([], 'anything', { now: NOW }), []);
  assert.deepEqual(rankMemories([doc('x', 'hello')], 'kubernetes', { now: NOW }), []);
});

test('recency decays with the half-life and never goes negative for future timestamps', () => {
  const halfLife = 10 * DAY;
  const hits = rankMemories(
    [doc('recent', 'word', NOW), doc('old', 'word', NOW - halfLife), doc('future', 'word', NOW + DAY)],
    'word',
    { now: NOW, halfLifeMs: halfLife },
  );
  const byId = Object.fromEntries(hits.map((hit) => [hit.record.id, hit.parts.recency]));
  assert.ok(byId.recent > 0.999);
  assert.ok(Math.abs(byId.old - 0.5) < 0.001);
  assert.equal(byId.future, 1);
});
