import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt, extractSessionSignals } from './transcriptSummary.ts';

const MEETING = [
  { who: 'them: Priya', text: 'Can we move the release to Thursday?' },
  { who: 'me', text: 'Thursday works if the migration is done.' },
  { who: 'them: Sam', text: 'We decided to keep the on-call rotation as it is.' },
  { who: 'them: Priya', text: "I'll follow up with the platform team by Friday." },
  { who: 'them: Sam', text: 'The budget review is still open.' },
  { who: 'them: Sam', text: 'We decided to keep the on-call rotation as it is.' },
];

test('finds questions, decisions and actions with their speaker labels', () => {
  const extraction = extractSessionSignals(MEETING);
  assert.deepEqual(extraction.questions, ['Can we move the release to Thursday?']);
  assert.deepEqual(extraction.decisions, ['We decided to keep the on-call rotation as it is.']);
  assert.deepEqual(extraction.actions, ["I'll follow up with the platform team by Friday."]);
  assert.match(extraction.transcript, /them: Priya: Can we move the release/);
  assert.equal(extraction.stats.lines, MEETING.length);
  assert.equal(extraction.stats.included, MEETING.length);
});

test('a repeated line is counted once', () => {
  const extraction = extractSessionSignals(MEETING);
  assert.equal(extraction.decisions.length, 1);
});

test('each bucket is capped, so a rambling meeting cannot flood the prompt', () => {
  const lines = Array.from({ length: 20 }, (_, index) => ({
    who: 'them',
    text: `Should we change topic number ${index}?`,
  }));
  const extraction = extractSessionSignals(lines);
  assert.equal(extraction.questions.length, 8);
});

test('clipping shortens the transcript but still reads signals from the tail', () => {
  const lines = [
    ...Array.from({ length: 200 }, (_, index) => ({
      who: 'them',
      text: `filler line ${index} about progress and status that goes on for a while`,
    })),
    { who: 'them: Priya', text: 'We decided to ship on Friday.' },
  ];
  const extraction = extractSessionSignals(lines, { maxChars: 600 });
  assert.ok(extraction.stats.included < extraction.stats.lines);
  assert.ok(extraction.stats.chars <= 600);
  assert.deepEqual(extraction.decisions, ['We decided to ship on Friday.']);
});

test('empty input produces an empty extraction instead of throwing', () => {
  const extraction = extractSessionSignals([]);
  assert.equal(extraction.transcript, '');
  assert.deepEqual(extraction.questions, []);
  assert.equal(extraction.stats.words, 0);
  const prompt = buildSummaryPrompt(extraction);
  assert.match(prompt.user, /\(no transcript\)/);
});

test('the prompt carries the signals, asks for groups and forbids invention', () => {
  const extraction = extractSessionSignals(MEETING);
  const prompt = buildSummaryPrompt(extraction);
  assert.match(prompt.system, /never invent/i);
  assert.match(prompt.system, /250 words/);
  assert.match(prompt.user, /Decisions detected:/);
  assert.match(prompt.user, /Action items detected:/);
  assert.match(prompt.user, /on-call rotation/);
});

test('an excerpt is labelled so the model knows it is partial', () => {
  const lines = Array.from({ length: 300 }, (_, index) => ({
    who: 'them',
    text: `line ${index} with enough words to consume the character budget quickly`,
  }));
  const prompt = buildSummaryPrompt(extractSessionSignals(lines, { maxChars: 500 }));
  assert.match(prompt.user, /\(excerpt\)/);
});
