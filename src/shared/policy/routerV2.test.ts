import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision, type RouteHints } from '../lumenRoute.ts';
import { planLanes, type ContextFeatures } from './routerV2.ts';

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

test('planLanes delegates the pinned v0.6 decisions unchanged', () => {
  for (const features of PINNED) {
    assert.deepEqual(
      planLanes(features).decision,
      routeDecision(features.question, asHints(features)),
      `question=${JSON.stringify(features.question)} feature=${JSON.stringify(features)}`,
    );
  }
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

test('forced tiers pass through the planner untouched', () => {
  for (const forceTier of ['fast', 'balanced', 'quality', 'auto'] as const) {
    const features: ContextFeatures = { question: 'Tell me about yourself', forceTier };
    assert.equal(planLanes(features).decision.tier, routeDecision(features.question, asHints(features)).tier);
  }
});

test('a single-tier decision yields one lane', () => {
  const plan = planLanes({ question: 'What is a mutex?', mode: 'general' });
  assert.deepEqual(plan.tiers, ['fast']);
});

test('an upgrade decision yields fast then quality', () => {
  const plan = planLanes({ question: 'Tell me about a time you led a project.' });
  assert.equal(plan.decision.preferUpgrade, true);
  assert.deepEqual(plan.tiers, ['fast', 'quality']);
});

test('the plan keeps the human-readable reason', () => {
  const plan = planLanes({ question: 'Tell me about yourself' });
  assert.equal(plan.reason, plan.decision.reason);
  assert.ok(plan.reason.length > 0);
});
