import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutScreen, prepareScreenContext } from './screenContext.ts';

test('garbled OCR of our own answer is removed from screen context', () => {
  const own = [
    'Common approaches include Token Bucket or Leaky Bucket algorithms, and defining the rate and burst limiters for an API.',
  ];
  const ocr = [
    'Candidate must know Python and SQL',
    'Htiorithms, and defining the rate and burst limitenforanAPi',
  ].join('\n');

  const cleaned = prepareScreenContext(ocr, own);
  assert.match(cleaned, /Python and SQL/);
  assert.doesNotMatch(cleaned, /Htiorithms|limitenforanAPi/);
});

test('a real screen line that merely shares a short phrase survives', () => {
  const own = ['We need to discuss the migration timeline tomorrow.'];
  const ocr = ['Billing migration: the migration timeline is in the shared document.'];
  const cleaned = prepareScreenContext(ocr.join('\n'), own);
  assert.equal(cleaned, ocr[0]);
});

test('screen questions are recognised', () => {
  for (const q of [
    'What is on my screen right now?',
    'Read the screen and solve it.',
    'Look at the interviewer’s screen.',
    'Summarise this screenshot.',
  ]) {
    assert.equal(asksAboutScreen(q), true, q);
  }
  assert.equal(asksAboutScreen('Tell me about your last project.'), false);
});