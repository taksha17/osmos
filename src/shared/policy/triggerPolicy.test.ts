import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_WINDOW_MS,
  SPECULATIVE_MIN_CONFIDENCE,
  classifyQuestion,
  decideTrigger,
  looksLikeMeetingCue,
  utteranceHash,
} from './triggerPolicy.ts';

/**
 * The Phase 0 parity corpus, kept as a deliberate-diff record. Phase 3 replaced
 * the `shouldAutoAssist` delegation with §7.3's trigger table, so questions must
 * still fire and the long statements v0.6 answered must become notes.
 */
const QUESTIONS: string[] = [
  'What?',
  'Why?',
  'What is 2+2?',
  'What does JVM stand for?',
  'What is a mutex?',
  'How does HTTPS work?',
  'Explain database indexing',
  'Can you send the deck by Friday?',
  'Could you walk me through the deployment flow?',
  'Tell me about yourself',
  'Tell me about a time you led a project.',
  'Walk me through your last system design.',
  'Why do you want to work here?',
  'What is your greatest strength?',
  'Where do you see yourself in five years?',
  'Do you have any questions for us?',
  'Have you worked with Kubernetes before?',
  'Is there a staging environment?',
  'Are there any blockers on the migration?',
  'What is the capital of France?',
];

const SILENCE: string[] = ['', ' ', 'hi', 'ok', 'thanks', 'yes', 'no', 'Hmm'];

/** Long statements v0.6 answered purely on length; §7.3 says note, not answer. */
const STATEMENTS: string[] = [
  'Okay so the plan is to ship on Thursday afternoon',
  'Good morning everyone, thanks for joining the call',
  'That is a really interesting point about latency budgets',
  'The meeting starts in about ten minutes',
  'Right, that covers the status update for this week',
];

/** Statements that carry an action item, decision or ownership (§7.3 meeting cue). */
const CUES: string[] = [
  'We should probably revisit the pricing page copy',
  'Absolutely, we can take that offline and follow up later',
  'No problem, I will send the notes after the call',
];

test('every direct question fires, with a confidence above the speculative bar', () => {
  for (const text of QUESTIONS) {
    const d = decideTrigger({ text });
    assert.equal(d.fire, true, `text=${JSON.stringify(text)}`);
    assert.equal(d.reason, 'direct-question', `text=${JSON.stringify(text)}`);
    assert.ok(d.confidence >= SPECULATIVE_MIN_CONFIDENCE, `text=${JSON.stringify(text)}`);
  }
});

test('short filler never fires', () => {
  for (const text of SILENCE) {
    const d = decideTrigger({ text });
    assert.equal(d.fire, false, `text=${JSON.stringify(text)}`);
    assert.equal(d.notes, false, `text=${JSON.stringify(text)}`);
  }
});

test('long statements are notes, not answers — the deliberate §7.3 diff', () => {
  for (const text of STATEMENTS) {
    const d = decideTrigger({ text });
    assert.equal(d.fire, false, `text=${JSON.stringify(text)}`);
    assert.equal(d.reason, 'no-trigger', `text=${JSON.stringify(text)}`);
  }
});

test('meeting cues are captured as notes and never answered', () => {
  for (const text of CUES) {
    const d = decideTrigger({ text });
    assert.equal(d.fire, false, `text=${JSON.stringify(text)}`);
    assert.equal(d.reason, 'meeting-cue', `text=${JSON.stringify(text)}`);
    assert.equal(d.notes, true, `text=${JSON.stringify(text)}`);
  }
});

test('looksLikeMeetingCue ignores small talk', () => {
  assert.equal(looksLikeMeetingCue('That is a really interesting point'), false);
  assert.equal(looksLikeMeetingCue('Let us schedule the retro for Monday'), true);
  assert.equal(looksLikeMeetingCue('We decided to delay the launch'), true);
});

test('classifyQuestion separates stems, explicit questions and statements', () => {
  assert.equal(classifyQuestion('What is a mutex?').confidence, 0.9);
  assert.equal(classifyQuestion('Tell me about a time you led a project.').confidence, 0.95);
  assert.equal(classifyQuestion('Explain database indexing').confidence, 0.8);
  // A mid-sentence question mark is weaker evidence than a closing one.
  assert.equal(classifyQuestion('the queue is fine? no, it is not').isQuestion, true);
  assert.equal(classifyQuestion('the queue is fine? no, it is not').confidence, 0.75);
  assert.equal(classifyQuestion('The deploy finished').isQuestion, false);
  assert.equal(classifyQuestion('').confidence, 0);
});

test('smartMode off suppresses everything except hotkeys', () => {
  assert.equal(decideTrigger({ text: 'What is a mutex?', smartMode: false }).fire, false);
  assert.equal(decideTrigger({ text: 'What is a mutex?', smartMode: false, hotkey: true }).fire, true);
});

test('hotkey always fires, even with empty context', () => {
  const d = decideTrigger({ text: '', hotkey: true, smartMode: false });
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'hotkey');
  assert.equal(decideTrigger({ text: 'hi', forceAssist: true }).fire, true);
});

test("the user's own speech never auto-fires", () => {
  const d = decideTrigger({ text: 'Can you send the deck by Friday?', channel: 'me' });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'self-speech');
});

test('a repeated utterance is suppressed inside the 10 s cooldown', () => {
  const text = 'Tell me about a time you led a project.';
  const hash = utteranceHash(text);
  assert.equal(hash, decideTrigger({ text }).hash);

  const inside = decideTrigger({ text, lastFiredHash: hash, lastFiredAtMs: 1_000, nowMs: 5_000 });
  assert.equal(inside.fire, false);
  assert.equal(inside.reason, 'duplicate');

  const outside = decideTrigger({
    text,
    lastFiredHash: hash,
    lastFiredAtMs: 1_000,
    nowMs: 1_000 + DUPLICATE_WINDOW_MS,
  });
  assert.equal(outside.fire, true);
});

test('a different question is never treated as a duplicate', () => {
  const first = decideTrigger({ text: 'What is a mutex?' });
  const second = decideTrigger({
    text: 'What is a monitor?',
    lastFiredHash: first.hash,
    lastFiredAtMs: 0,
    nowMs: 1_000,
  });
  assert.equal(second.fire, true);
});

test('confident partials start speculatively; weak partials wait for the final', () => {
  const strong = decideTrigger({ text: 'Tell me about a time you led a proj', isFinal: false });
  assert.equal(strong.fire, true);
  assert.equal(strong.speculative, true);
  assert.equal(strong.reason, 'speculative');

  const weak = decideTrigger({ text: 'Okay so the plan is to shi', isFinal: false });
  assert.equal(weak.fire, false);

  const final = decideTrigger({ text: 'Tell me about a time you led a project.', isFinal: true });
  assert.equal(final.fire, true);
  assert.equal(final.speculative, false);
});

test('a stable coding screen is offered as a note unless auto-fire is enabled', () => {
  const problem = 'Given an array of integers, return the indices of the two numbers that add up to target.';
  const offered = decideTrigger({ text: problem, codingScreen: true, mode: 'coding' });
  assert.equal(offered.fire, false);
  assert.equal(offered.reason, 'coding-screen');
  assert.equal(offered.notes, true);

  const auto = decideTrigger({
    text: problem,
    codingScreen: true,
    mode: 'coding',
    autoFireCodingScreen: true,
  });
  assert.equal(auto.fire, true);
  assert.equal(auto.reason, 'coding-screen');
  assert.equal(auto.notes, false);

  // Outside coding mode the screen rule never auto-fires.
  const elsewhere = decideTrigger({
    text: problem,
    codingScreen: true,
    mode: 'interview',
    autoFireCodingScreen: true,
  });
  assert.equal(elsewhere.fire, false);
});

test('utteranceHash ignores case and whitespace noise but separates content', () => {
  assert.equal(utteranceHash('Tell  me about\nyourself'), utteranceHash('tell me about yourself'));
  assert.notEqual(utteranceHash('What is a mutex?'), utteranceHash('What is a monitor?'));
});
