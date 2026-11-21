import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnswerContext,
  looksLikeCodeScreen,
  splitFacts,
} from './answerContext.ts';

const CODE_SCREEN = [
  'Given an array of integers nums and an integer target, return indices of the two numbers that add up to target.',
  'class Solution {',
  '  public int[] twoSum(int[] nums, int target) {',
  '    const seen = new Map();',
  '    return new int[] { 0, 1 };',
  '  }',
  '}',
].join('\n');

const SLIDE_SCREEN = [
  'Q3 roadmap review',
  'We should cut the onboarding rewrite and ship the billing migration first.',
  'Owner: Priya',
].join('\n');

test('looksLikeCodeScreen needs two independent code hints', () => {
  assert.equal(looksLikeCodeScreen(CODE_SCREEN), true);
  assert.equal(looksLikeCodeScreen(SLIDE_SCREEN), false);
  assert.equal(looksLikeCodeScreen(''), false);
  // A single hint in prose is not a code screen.
  assert.equal(looksLikeCodeScreen('I will return the deck after the call'), false);
});

test('splitFacts turns a résumé blob into bullets', () => {
  const resume = [
    'Jane Doe — Senior Engineer',
    '• Led the billing migration for 4 services.',
    '- Cut p95 latency by 38%.',
    '1. Mentored three engineers.',
  ].join('\n');
  const facts = splitFacts(resume);
  assert.deepEqual(facts, [
    'Jane Doe — Senior Engineer',
    'Led the billing migration for 4 services.',
    'Cut p95 latency by 38%.',
    'Mentored three engineers.',
  ]);
});

test('splitFacts caps the fact list and tolerates empty input', () => {
  assert.deepEqual(splitFacts(''), []);
  assert.deepEqual(splitFacts(undefined), []);
  assert.equal(splitFacts('Line one.\nLine two.\nLine three.', 2).length, 2);
});

test('a code snapshot forces the vision lane and is marked as code', () => {
  const ctx = buildAnswerContext({
    mode: 'coding',
    question: 'Why does this fail on the empty array?',
    screen: { snapshotId: 'snap-1', ocrText: CODE_SCREEN },
  });
  assert.equal(ctx.hasScreen, true);
  assert.equal(ctx.hasCodeScreen, true);
  assert.equal(ctx.plan.requiresVision, true);
  assert.equal(ctx.plan.primary, 'quality');
  assert.equal(ctx.packet.mode, 'coding');
  assert.equal(ctx.packet.constraints.format, 'code');
  assert.match(ctx.packet.screen?.ocrText ?? '', /twoSum/);
});

test('a code snapshot with no vision model falls back to OCR text', () => {
  const ctx = buildAnswerContext({
    mode: 'general',
    question: 'Why does this fail?',
    screen: { snapshotId: 'snap-1', ocrText: CODE_SCREEN },
    visionAvailable: false,
  });
  assert.equal(ctx.plan.requiresVision, true);
  assert.equal(ctx.plan.visionFallback, true);
  assert.match(ctx.plan.reason, /OCR text only/);
});

test('a slide is screen context but not a code screen', () => {
  const ctx = buildAnswerContext({
    mode: 'meeting',
    question: 'What did we decide about the roadmap?',
    screen: { snapshotId: 'snap-2', ocrText: SLIDE_SCREEN },
  });
  assert.equal(ctx.hasScreen, true);
  assert.equal(ctx.hasCodeScreen, false);
  assert.equal(ctx.plan.requiresVision, false);
});

test('the packet uses the speaker channel and finality of the request', () => {
  const ctx = buildAnswerContext({
    mode: 'interview',
    question: 'Tell me about yourself',
    channel: 'me',
    isFinal: false,
  });
  assert.equal(ctx.packet.question.speaker, 'me');
  assert.equal(ctx.packet.question.isFinal, false);
  assert.equal(ctx.packet.question.text, 'Tell me about yourself');
});

test('a résumé becomes packet facts and a bank match is carried through', () => {
  const ctx = buildAnswerContext({
    mode: 'interview',
    question: 'Why do you want to work here?',
    profile: {
      resume: 'Led the billing migration.\nMentored three engineers.',
      jd: 'Kubernetes experience required',
      companyIntel: 'Observability-focused product company',
    },
    bankMatch: { questionId: 'q-why', answer: 'The observability roadmap.', score: 0.9 },
  });
  assert.deepEqual(ctx.packet.profile?.resumeFacts, [
    'Led the billing migration.',
    'Mentored three engineers.',
  ]);
  assert.deepEqual(ctx.packet.profile?.jdFacts, ['Kubernetes experience required']);
  assert.equal(ctx.packet.bankMatch?.questionId, 'q-why');
  assert.ok(ctx.packet.usage.total > 0);
});

test('interview questions still draft fast first', () => {
  const ctx = buildAnswerContext({
    mode: 'interview',
    question: 'Tell me about a time you led a project.',
  });
  assert.deepEqual(ctx.plan.tiers, ['fast', 'quality']);
  assert.equal(ctx.plan.primary, 'fast');
});

test('benchmarked thresholds reach the lane plan', () => {
  const question =
    'The retry queue keeps growing whenever the primary database instance is restarted by the operator during the nightly backup window';
  const wide = buildAnswerContext(
    { mode: 'general', question },
    { thresholds: { easyMaxWords: 40 } },
  );
  assert.equal(wide.plan.primary, 'fast');
  assert.deepEqual(wide.plan.tiers, ['fast', 'quality']);
});

test('an empty screen never becomes a screen section', () => {
  const ctx = buildAnswerContext({
    mode: 'general',
    question: 'What is a mutex?',
    screen: { snapshotId: 'snap-3', ocrText: '   ' },
  });
  assert.equal(ctx.hasScreen, false);
  assert.equal(ctx.packet.screen, undefined);
  assert.equal(ctx.packet.usage.screen, 0);
});
