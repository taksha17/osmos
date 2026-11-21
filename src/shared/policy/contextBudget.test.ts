import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_BUDGET,
  buildContextPacket,
  clipToTokens,
  estimateTokens,
  selectTranscript,
  type ContextBudget,
} from './contextBudget.ts';

test('estimateTokens approximates 4 characters per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   '), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(401)), 101);
});

test('clipToTokens leaves text that fits untouched', () => {
  const text = 'Explain database indexing';
  assert.equal(clipToTokens(text, 100), text);
});

test('clipToTokens cuts on a sentence boundary when one is available', () => {
  const text = 'First sentence here. Second sentence follows with more words after it.';
  const clipped = clipToTokens(text, 8);
  assert.ok(clipped.length < text.length);
  assert.ok(clipped.endsWith('.'), clipped);
  assert.ok(!clipped.includes('more words'), clipped);
});

test('clipToTokens always respects the budget', () => {
  const text = 'word '.repeat(500);
  const clipped = clipToTokens(text, 20);
  assert.ok(estimateTokens(clipped) <= 20, `${estimateTokens(clipped)} tokens`);
});

test('clipToTokens returns empty for a zero budget', () => {
  assert.equal(clipToTokens('anything at all', 0), '');
});

test('selectTranscript keeps conversation order and honours the budget', () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    who: i % 2 === 0 ? 'them' : 'me',
    text: `Line ${i} about the deployment pipeline and its retries`,
  }));
  const kept = selectTranscript(lines, 120, 'What about the deployment pipeline?');
  assert.ok(kept.length > 0 && kept.length < lines.length);
  assert.ok(
    kept.reduce((sum, line) => sum + estimateTokens(line.text), 0) <= 120,
    'within budget',
  );
  const order = kept.map((line) => lines.findIndex((l) => l.text === line.text));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'chronological');
});

test('selectTranscript prefers the most recent lines when nothing else differs', () => {
  const lines = [
    { who: 'them', text: 'alpha beta gamma delta epsilon' },
    { who: 'them', text: 'zeta eta theta iota kappa' },
  ];
  const kept = selectTranscript(lines, 10, '');
  assert.deepEqual(kept.map((l) => l.text), [lines[1].text]);
});

test('buildContextPacket fills the packet shape with defaults', () => {
  const packet = buildContextPacket({ mode: 'interview', question: { text: 'Tell me about yourself' } });
  assert.equal(packet.mode, 'interview');
  assert.equal(packet.question.text, 'Tell me about yourself');
  assert.equal(packet.question.speaker, 'them');
  assert.equal(packet.question.isFinal, true);
  assert.deepEqual(packet.recentTranscript, []);
  assert.equal(packet.constraints.format, 'speakable');
  assert.equal(packet.constraints.language, 'en');
  assert.equal(packet.usage.total, packet.usage.question);
});

test('coding mode defaults to a code format and a longer spoken budget', () => {
  const packet = buildContextPacket({ mode: 'coding', question: { text: 'Find the bug' } });
  assert.equal(packet.constraints.format, 'code');
  assert.equal(packet.constraints.maxSpokenSeconds, 90);
});

test('buildContextPacket never exceeds the section budgets', () => {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, transcript: 60, screen: 40 };
  const packet = buildContextPacket(
    {
      mode: 'meeting',
      question: { text: 'What did we decide about the rollout?' },
      transcript: Array.from({ length: 30 }, (_, i) => ({
        who: 'them',
        text: `Turn ${i} covering the rollout plan, the rollback plan and the owners`,
      })),
      screen: { snapshotId: 's1', ocrText: 'screen text '.repeat(400) },
      retrieved: Array.from({ length: 20 }, (_, i) => ({
        source: `doc-${i}`,
        text: 'retrieved context about rollout '.repeat(50),
        score: 1 - i / 20,
      })),
    },
    budget,
  );
  assert.ok(packet.usage.transcript <= budget.transcript, String(packet.usage.transcript));
  assert.ok(packet.usage.screen <= budget.screen, String(packet.usage.screen));
  assert.ok(packet.usage.retrieved <= budget.retrieved, String(packet.usage.retrieved));
});

test('retrieved chunks are kept in score order', () => {
  const packet = buildContextPacket({
    mode: 'general',
    question: { text: 'How does the cache invalidate?' },
    retrieved: [
      { source: 'low', text: 'cache invalidation notes from the archive', score: 0.2 },
      { source: 'high', text: 'cache invalidation design doc', score: 0.9 },
    ],
  });
  assert.equal(packet.retrieved?.[0].source, 'high');
  assert.equal(packet.retrieved?.[1].source, 'low');
});

test('profile facts relevant to the question survive trimming', () => {
  const packet = buildContextPacket({
    mode: 'interview',
    question: { text: 'Have you worked with Kubernetes?' },
    profile: {
      resumeFacts: [
        'Led a team of four on the payments rewrite',
        'Ran the Kubernetes migration for the billing service',
        'Taught a weekend design course',
      ],
      jdFacts: ['Kubernetes experience required'],
    },
  });
  assert.ok(packet.profile?.resumeFacts.includes('Ran the Kubernetes migration for the billing service'));
  assert.ok(packet.profile?.jdFacts.includes('Kubernetes experience required'));
});

test('a bank match is carried through for the grounding rule', () => {
  const packet = buildContextPacket({
    mode: 'interview',
    question: { text: 'Why do you want to work here?' },
    bankMatch: { questionId: 'q-why', answer: 'Because of the observability roadmap.', score: 0.93 },
  });
  assert.equal(packet.bankMatch?.questionId, 'q-why');
  assert.ok(packet.bankMatch?.answer.includes('observability'));
  assert.ok(packet.usage.retrieved >= estimateTokens('Because of the observability roadmap.'));
});
