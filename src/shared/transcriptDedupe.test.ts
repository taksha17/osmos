import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileFinalTranscript } from './transcriptDedupe.ts';

test('exact duplicate final is skipped inside the window', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'How would you design a rate limiter?', at: 1_000 },
      'How would you design a rate limiter?',
      5_000,
    ),
    { action: 'skip' },
  );
});

test('a longer version replaces an earlier prefix in place', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'Tell me about yourself and why you are interested in this senior.', at: 1_000 },
      'Tell me about yourself and why you are interested in this senior frontend role.',
      5_000,
    ),
    {
      action: 'replace',
      text: 'Tell me about yourself and why you are interested in this senior frontend role.',
    },
  );
});

test('a shorter prefix that arrives late is skipped', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'What signals tell you a code review is becoming ineffective?', at: 1_000 },
      'What signals tell you a code review',
      4_000,
    ),
    { action: 'skip' },
  );
});

test('the same question later than the window is a new final', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'What is your greatest strength?', at: 1_000 },
      'What is your greatest strength?',
      20_000,
    ),
    { action: 'add', text: 'What is your greatest strength?' },
  );
});

test('a different question is never merged', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'Tell me about yourself.', at: 1_000 },
      'How do you handle conflict?',
      2_000,
    ),
    { action: 'add', text: 'How do you handle conflict?' },
  );
});

test('normalization ignores punctuation and case for duplicates', () => {
  assert.deepEqual(
    reconcileFinalTranscript(
      { text: 'Tell me about yourself!', at: 1_000 },
      'tell me about yourself',
      2_000,
    ),
    { action: 'skip' },
  );
});
