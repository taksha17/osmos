import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery, decideWebSearch } from './webNeed.ts';

const NOW = new Date('2026-11-21T12:00:00Z');

function interview(question: string) {
  return decideWebSearch({ question, mode: 'interview', providerEnabled: true, now: NOW });
}

test('interview freshness questions turn on live web research', () => {
  const version = interview('What is the latest version of React?');
  assert.equal(version.search, true);
  assert.equal(version.reason, 'freshness-sensitive');
  assert.equal(version.freshness, 'current');
  assert.deepEqual(version.signals, ['latest', 'version']);

  const practices = interview('What are the current best practices for RAG evaluation?');
  assert.equal(practices.search, true);
  assert.equal(practices.freshness, 'current');

  const ceo = interview('Who is the CEO of Anthropic right now?');
  assert.equal(ceo.search, true);
  assert.equal(ceo.freshness, 'live');

  const release = interview('What did OpenAI announce this week?');
  assert.equal(release.search, true);

  const pricing = interview("What's the price of Claude Pro?");
  assert.equal(pricing.search, true);

  const news = interview("What's happening in the news today?");
  assert.equal(news.search, true);

  const changed = interview("What's new in Kubernetes 1.32?");
  assert.equal(changed.search, true);
});

test('stable interview questions stay on the model', () => {
  for (const question of [
    'What is a mutex?',
    'How does HTTPS work?',
    'Explain database indexing',
    'What is the capital of France?',
    'How would you design a rate limiter?',
    'What is the best way to reverse a linked list?',
    "What's the difference between TCP and UDP?",
    'What is 2 + 2?',
  ]) {
    const decision = interview(question);
    assert.equal(decision.search, false, question);
    assert.equal(decision.reason, 'stable-knowledge', question);
    assert.equal(decision.freshness, 'stable', question);
  }
});

test('personal and behavioural answers never search, even with freshness words', () => {
  for (const question of [
    'Tell me about a time you led a project.',
    'What is your greatest strength?',
    'Describe your current project.',
    'What are your salary expectations?',
    'Walk me through your last system design.',
    'Why do you want to work here?',
  ]) {
    const decision = interview(question);
    assert.equal(decision.search, false, question);
    assert.equal(decision.reason, 'personal-answer', question);
  }
});

test('an explicit web request always wins', () => {
  for (const question of [
    'Search the web for the Node LTS schedule',
    'look up the latest Postgres release',
    'google the pricing for Vercel',
    'check online whether the API is deprecated',
  ]) {
    const decision = interview(question);
    assert.equal(decision.search, true, question);
    assert.equal(decision.reason, 'explicit-request', question);
    assert.equal(decision.explicit, true, question);
  }
});

test('clock questions are answered from the prompt date, not the web', () => {
  for (const question of ["What's today's date?", 'What time is it?', 'What day is it today?']) {
    const decision = interview(question);
    assert.equal(decision.search, false, question);
    assert.equal(decision.reason, 'date-time-question', question);
  }
});

test('turning web search off reports the gap instead of searching', () => {
  const decision = decideWebSearch({
    question: 'What is the latest version of React?',
    mode: 'interview',
    providerEnabled: false,
    now: NOW,
  });
  assert.equal(decision.search, false);
  assert.equal(decision.reason, 'web-search-off');
  // Freshness survives so the prompt can say the answer may be stale.
  assert.equal(decision.freshness, 'current');
});

test('meeting and general keep the always-on behaviour', () => {
  for (const mode of ['meeting', 'general'] as const) {
    const decision = decideWebSearch({
      question: 'What is a mutex?',
      mode,
      providerEnabled: true,
      now: NOW,
    });
    assert.equal(decision.search, true, mode);
    assert.equal(decision.reason, 'mode-always-searches', mode);
  }
});

test('empty input never searches', () => {
  const decision = decideWebSearch({ question: '   ', mode: 'interview', providerEnabled: true });
  assert.equal(decision.search, false);
  assert.equal(decision.reason, 'empty-question');
  assert.equal(decision.query, '');
});

test('the query drops filler, trailing punctuation and gains the current year', () => {
  const query = buildSearchQuery('  Can you tell me the latest React version?  ', { now: NOW });
  assert.equal(query, 'the latest React version 2026');
});

test('the query never appends a second year', () => {
  const query = buildSearchQuery('What is the latest React version in 2025?', { now: NOW });
  assert.equal(query, 'What is the latest React version in 2025');
});

test('a terse follow-up is anchored to the screen topic', () => {
  const screen = [
    'Two Sum',
    'Given an array of integers, return indices of the two numbers that add to a target.',
  ].join('\n');
  const query = buildSearchQuery('what about this?', { screenText: screen, now: NOW });
  assert.match(query, /^what about this Two Sum/);
});

test('a complete question is not padded with screen text', () => {
  const query = buildSearchQuery('What are the current best practices for RAG evaluation?', {
    screenText: 'Two Sum — Given an array of integers, return indices.',
    now: NOW,
  });
  assert.equal(query, 'What are the current best practices for RAG evaluation 2026');
});
