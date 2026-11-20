import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision, EASY_MAX_WORDS } from './lumenRoute.ts';

test('easy short question routes fast even in interview mode', () => {
  const d = routeDecision('What does JVM stand for?', { mode: 'interview' });
  assert.equal(d.tier, 'fast');
  assert.equal(d.preferUpgrade, false);
});

test('high-stakes keyword still routes quality in interview mode', () => {
  const d = routeDecision('Tell me about yourself', { mode: 'interview' });
  assert.equal(d.tier, 'quality');
});

test('bank match routes fast unconditionally, overriding high-stakes phrasing', () => {
  const d = routeDecision('Why do you want to work here?', { mode: 'interview', bankMatch: true });
  assert.equal(d.tier, 'fast');
});

test('same question without bank match stays quality (high-stakes)', () => {
  const d = routeDecision('Why do you want to work here?', { mode: 'interview' });
  assert.equal(d.tier, 'quality');
});

test('screen context attached never routes fast', () => {
  const d = routeDecision('What does this screen show here', { mode: 'general', hasScreen: true });
  assert.equal(d.tier, 'quality');
});

test('complex keyword in a short question stays out of fast', () => {
  const d = routeDecision('Explain database indexing', { mode: 'general' });
  assert.notEqual(d.tier, 'fast');
});

test('forced tier still wins over easy and bank rules', () => {
  const d = routeDecision('What does JVM stand for?', { forceTier: 'quality' });
  assert.equal(d.tier, 'quality');
});

test('EASY_MAX_WORDS is 18', () => {
  assert.equal(EASY_MAX_WORDS, 18);
});
