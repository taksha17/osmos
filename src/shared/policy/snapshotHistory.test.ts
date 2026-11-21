import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_MEMORY_DEFAULTS,
  SNAPSHOT_MIN_GAP_MS,
  recentSnapshots,
  rememberSnapshot,
} from './snapshotHistory.ts';

const NOW = 1_000_000;

function memory(...entries: Array<[number, string]>) {
  return entries.reduce(
    (acc, [at, text]) => rememberSnapshot(acc, { at, text }),
    [] as ReturnType<typeof rememberSnapshot>,
  );
}

test('entries are kept oldest first and bounded by count', () => {
  const window = memory([NOW - 3000, 'first'], [NOW - 2000, 'second'], [NOW - 1000, 'third']);
  assert.deepEqual(
    window.map((entry) => entry.text),
    ['first', 'second', 'third'],
  );

  const capped = rememberSnapshot(window, { at: NOW, text: 'fourth' }, { maxEntries: 2 });
  assert.deepEqual(
    capped.map((entry) => entry.text),
    ['third', 'fourth'],
  );
});

test('an unchanged screen replaces its entry instead of stacking', () => {
  const window = memory([NOW - 3000, 'class A {}'], [NOW - 2000, 'class A {}']);
  assert.equal(window.length, 1);
  assert.equal(window[0]!.at, NOW - 2000);
});

test('the kind is classified from the text when not supplied', () => {
  const [entry] = rememberSnapshot([], {
    at: NOW,
    text: 'class Cart {\n  add(item) {\n    return item;\n  }\n}',
  });
  assert.equal(entry!.kind, 'code');
});

test('history excludes the snapshot being answered and stale entries', () => {
  const window = memory(
    [NOW - 200_000, 'ancient'],
    [NOW - 5000, 'previous'],
    [NOW - 200, 'current'],
  );

  const history = recentSnapshots(window, { now: NOW, beforeAt: NOW - 200, limit: 3 });
  assert.deepEqual(
    history.map((entry) => entry.text),
    ['previous'],
    'older-than-current, fresh, and not the current snapshot',
  );
});

test('the gap rule keeps near-simultaneous captures out of the history', () => {
  const window = memory([NOW - 100, 'almost same moment'], [NOW, 'current']);
  const history = recentSnapshots(window, { now: NOW, beforeAt: NOW });
  assert.deepEqual(history, []);
  assert.equal(SNAPSHOT_MIN_GAP_MS, 1000);
});

test('limits and empty input behave', () => {
  assert.deepEqual(recentSnapshots([], { now: NOW }), []);
  assert.deepEqual(rememberSnapshot([], { at: NOW, text: '   ' }), []);
  const window = memory([NOW - 5000, 'a'], [NOW - 4000, 'b'], [NOW - 3000, 'c']);
  assert.equal(recentSnapshots(window, { now: NOW, limit: 2 }).length, 2);
  assert.equal(SNAPSHOT_MEMORY_DEFAULTS.maxEntries, 3);
  assert.equal(recentSnapshots(window, { now: Number.NaN }).length, 0);
});
