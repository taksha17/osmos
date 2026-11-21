import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_BUDGET,
  buildContextPacket,
  estimateTokens,
} from './contextBudget.ts';

const CURRENT = 'class Cart {\n  add(item) {\n    return item;\n  }\n}';

function packet(previous: Array<{ at: number; kind?: string; ocrText: string }>) {
  return buildContextPacket({
    mode: 'coding',
    question: { text: 'and now?' },
    screen: { snapshotId: 'snap-now', ocrText: CURRENT, previous },
  });
}

test('history is clipped into its own share and kept in chronological order', () => {
  const built = packet([
    { at: 3_000, kind: 'code', ocrText: 'class A {\n  size() { return 1; }\n}' },
    { at: 2_000, kind: 'code', ocrText: 'class B {\n  size() { return 2; }\n}' },
  ]);

  assert.equal(built.screen?.ocrText, CURRENT, 'the current snapshot keeps the rest of the budget');
  assert.deepEqual(
    built.screen?.previous?.map((entry) => entry.at),
    [2_000, 3_000],
  );
  assert.equal(built.screen?.previous?.[0]?.kind, 'code');
});

test('history never pushes the screen section over its budget', () => {
  const long = 'x'.repeat(DEFAULT_CONTEXT_BUDGET.screen * 4);
  const built = packet([
    { at: 1_000, ocrText: long },
    { at: 2_000, ocrText: long },
    { at: 3_000, ocrText: long },
  ]);

  const previousTokens = (built.screen?.previous ?? []).reduce(
    (sum, entry) => sum + estimateTokens(entry.ocrText),
    0,
  );
  assert.ok(previousTokens <= Math.floor(DEFAULT_CONTEXT_BUDGET.screen * 0.4) + 1);
  assert.equal(built.usage.screen, estimateTokens(built.screen?.ocrText ?? '') + previousTokens);
  assert.ok(built.usage.total <= Object.values(DEFAULT_CONTEXT_BUDGET).reduce((a, b) => a + b, 0));
});

test('no history means no previous section', () => {
  const built = packet([]);
  assert.equal(built.screen?.previous, undefined);
});

test('the packet stays chronological and coding-formatted', () => {
  const built = packet([{ at: 1_000, ocrText: 'def f():\n    return 1' }]);
  assert.equal(built.mode, 'coding');
  assert.equal(built.constraints.format, 'code');
  assert.equal(built.screen?.previous?.length, 1);
});
