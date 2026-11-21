import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerContext } from './answerContext.ts';
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from './contextBudget.ts';

const NOW = 1_700_000_000_000;

function memory(id: string, text: string, score: number, kind = 'message') {
  return { id, kind, at: NOW, text, score };
}

test('memories reach the packet, best score first', () => {
  const context = buildAnswerContext({
    mode: 'interview',
    question: 'Tell me about the migration',
    memory: [
      memory('low', 'a weak match about migration', 0.2),
      memory('high', 'led the migration to Postgres', 0.9),
    ],
  });

  assert.deepEqual(
    context.packet.memory?.map((entry) => entry.id),
    ['high', 'low'],
  );
  assert.equal(context.packet.memory?.[0]!.text, 'led the migration to Postgres');
});

test('the memory section respects its budget instead of pasting everything', () => {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, memory: 40 };
  const long = 'word '.repeat(400);
  const context = buildAnswerContext(
    {
      mode: 'interview',
      question: 'anything',
      memory: [memory('a', long, 0.9), memory('b', long, 0.8), memory('c', long, 0.7)],
    },
    { budget },
  );

  assert.ok(context.packet.usage.memory <= budget.memory);
  assert.ok((context.packet.memory?.length ?? 0) >= 1, 'at least the best match should survive');
});

test('no memories means no section and no usage', () => {
  const context = buildAnswerContext({ mode: 'interview', question: 'hello' });
  assert.equal(context.packet.memory, undefined);
  assert.equal(context.packet.usage.memory, 0);
});

test('memory usage is included in the packet total', () => {
  const withMemory = buildAnswerContext({
    mode: 'interview',
    question: 'hello',
    memory: [memory('a', 'a remembered answer about the team', 0.5)],
  });
  const without = buildAnswerContext({ mode: 'interview', question: 'hello' });
  assert.ok(withMemory.packet.usage.memory > 0);
  assert.ok(withMemory.packet.usage.total > without.packet.usage.total);
});
