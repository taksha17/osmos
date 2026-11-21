import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EASY_MAX_WORDS, routeDecision, type RouteHints } from '../lumenRoute.ts';
import {
  DEFAULT_ROUTER_THRESHOLDS,
  FIRST_TOKEN_BUDGET_MS,
  nextLane,
  pickEasyMaxWords,
  planLanes,
  type ContextFeatures,
} from './routerV2.ts';

/** The eight cases pinned in `lumenRoute.test.ts`, restated as features. */
const PINNED: ContextFeatures[] = [
  { question: 'What does JVM stand for?', mode: 'interview' },
  { question: 'Tell me about yourself', mode: 'interview' },
  { question: 'Why do you want to work here?', mode: 'interview', bankMatch: true },
  { question: 'Why do you want to work here?', mode: 'interview' },
  { question: 'What does this screen show here', mode: 'general', hasScreen: true },
  { question: 'Explain database indexing', mode: 'general' },
  { question: 'What does JVM stand for?', forceTier: 'quality' },
  { question: 'What does JVM stand for?', mode: 'interview', bankMatch: true, hasScreen: true },
];

const QUESTIONS = [
  '',
  'hi',
  'What is 2+2?',
  'What is a mutex?',
  'Tell me about a time you led a project.',
  'Walk me through your last system design.',
  'Can you send the deck by Friday?',
  'We should probably revisit the pricing page copy before launch day',
  'Summarize the trade-offs of CRDTs versus operational transforms in detail please',
  'Explain database indexing',
];

function asHints(f: ContextFeatures): RouteHints {
  return {
    mode: f.mode,
    hasScreen: f.hasScreen,
    bankMatch: f.bankMatch,
    forceTier: f.forceTier,
  };
}

test('planLanes keeps the v0.6 decision unchanged at the default thresholds', () => {
  for (const features of PINNED) {
    assert.deepEqual(
      planLanes(features).decision,
      routeDecision(features.question, asHints(features)),
      `question=${JSON.stringify(features.question)} feature=${JSON.stringify(features)}`,
    );
  }
  assert.equal(DEFAULT_ROUTER_THRESHOLDS.easyMaxWords, EASY_MAX_WORDS);
});

test('planLanes matches routeDecision across questions and hint combinations', () => {
  const modes: Array<ContextFeatures['mode']> = [undefined, 'interview', 'meeting', 'general'];
  for (const question of QUESTIONS) {
    for (const mode of modes) {
      for (const hasScreen of [false, true]) {
        for (const bankMatch of [false, true]) {
          const features: ContextFeatures = { question, mode, hasScreen, bankMatch };
          assert.deepEqual(
            planLanes(features).decision,
            routeDecision(question, asHints(features)),
            `question=${JSON.stringify(question)} mode=${mode} screen=${hasScreen} bank=${bankMatch}`,
          );
        }
      }
    }
  }
});

test('a fast decision still plans the quality lane as its fallback', () => {
  const plan = planLanes({ question: 'What is a mutex?', mode: 'general' });
  assert.equal(plan.primary, 'fast');
  assert.deepEqual(plan.tiers, ['fast', 'quality']);
});

test('an upgrade decision drafts fast, then upgrades', () => {
  const plan = planLanes({ question: 'Tell me about a time you led a project.' });
  assert.equal(plan.decision.preferUpgrade, true);
  assert.deepEqual(plan.tiers, ['fast', 'quality']);
});

test('a quality-only decision has nowhere to fall back to', () => {
  const plan = planLanes({ question: 'Tell me about yourself', forceTier: 'quality' });
  assert.deepEqual(plan.tiers, ['quality']);
  assert.equal(nextLane(plan, 'quality'), null);
});

test('the fallback chain advances one lane at a time', () => {
  const plan = planLanes({ question: 'What is a mutex?', mode: 'general' });
  assert.equal(nextLane(plan, 'fast'), 'quality');
  assert.equal(nextLane(plan, 'balanced'), 'quality');
  assert.equal(nextLane(plan, 'quality'), null);
});

test('every plan carries the first-token budget from §8.2', () => {
  const plan = planLanes({ question: 'What is a mutex?' });
  assert.equal(plan.firstTokenBudgetMs, FIRST_TOKEN_BUDGET_MS);
  assert.equal(plan.firstTokenBudgetMs, 2500);
});

test('a code snapshot forces the vision-capable quality lane', () => {
  const plan = planLanes({ question: 'Why does this test fail?', mode: 'general', hasCodeScreen: true });
  assert.equal(plan.requiresVision, true);
  assert.equal(plan.visionFallback, false);
  assert.equal(plan.primary, 'quality');
  assert.deepEqual(plan.tiers, ['quality']);
  assert.match(plan.reason, /vision lane required/);
});

test('with no vision model the plan says it is answering from OCR text', () => {
  const plan = planLanes({
    question: 'Why does this test fail?',
    mode: 'general',
    hasCodeScreen: true,
    visionAvailable: false,
  });
  assert.equal(plan.requiresVision, true);
  assert.equal(plan.visionFallback, true);
  assert.match(plan.reason, /OCR text only/);
});

test('forced tiers pass through the planner untouched', () => {
  for (const forceTier of ['fast', 'balanced', 'quality', 'auto'] as const) {
    const features: ContextFeatures = { question: 'Tell me about yourself', forceTier };
    assert.equal(
      planLanes(features).decision.tier,
      routeDecision(features.question, asHints(features)).tier,
    );
  }
});

test('the plan keeps the human-readable reason', () => {
  const plan = planLanes({ question: 'Tell me about yourself' });
  assert.equal(plan.reason, plan.decision.reason);
  assert.ok(plan.reason.length > 0);
});

test('benchmarked thresholds can move the easy-question boundary', () => {
  const question =
    'The retry queue keeps growing whenever the primary database instance is restarted by the operator during the nightly backup window';
  assert.ok(question.split(/\s+/).length > EASY_MAX_WORDS, 'fixture must exceed the default');

  const atDefault = planLanes({ question, mode: 'general' });
  const wide = planLanes({ question, mode: 'general' }, { thresholds: { easyMaxWords: 40 } });

  assert.equal(atDefault.decision.tier, 'balanced');
  assert.equal(wide.decision.tier, 'fast');
  assert.equal(wide.primary, 'fast');
  assert.deepEqual(wide.tiers, ['fast', 'quality']);
});

test('pickEasyMaxWords keeps the default with no eval data', () => {
  assert.equal(pickEasyMaxWords([]), EASY_MAX_WORDS);
});

test('pickEasyMaxWords stops at the first fast-lane mistake', () => {
  const observations = [
    { words: 3, fastCorrect: true },
    { words: 8, fastCorrect: true },
    { words: 12, fastCorrect: false },
    { words: 20, fastCorrect: true },
  ];
  assert.equal(pickEasyMaxWords(observations), 8);
});

test('pickEasyMaxWords falls back when the shortest question already fails', () => {
  assert.equal(pickEasyMaxWords([{ words: 4, fastCorrect: false }]), EASY_MAX_WORDS);
});
