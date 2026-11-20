import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoAssist } from '../continuousAssist.ts';
import { decideTrigger, utteranceHash } from './triggerPolicy.ts';

/**
 * Parity corpus for Architecture v2 §7.3. Phase 0's policy must make exactly
 * the same fire/no-fire decision as the v0.6 heuristic; when a later phase
 * replaces the body, these cases show up as deliberate diffs.
 */
const CORPUS: string[] = [
  '',
  ' ',
  'hi',
  'ok',
  'thanks',
  'yes',
  'no',
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
  'Let us circle back after lunch',
  'I think the deploy is finished now',
  'The meeting starts in about ten minutes',
  'We should probably revisit the pricing page copy',
  'Okay so the plan is to ship on Thursday afternoon',
  'Right, that covers the status update for this week',
  'Alright, let us move on to the next agenda item',
  'Good morning everyone, thanks for joining the call',
  'That is a really interesting point about latency budgets',
  'Absolutely, we can take that offline and follow up later',
  'No problem, I will send the notes after the call',
  'Sure, that works for me',
  'Hmm',
  'What is the capital of France?',
  'Summarize the trade-offs of CRDTs versus operational transforms',
];

for (const smartMode of [true, false]) {
  test(`decideTrigger.fire matches shouldAutoAssist across the corpus (smartMode=${smartMode})`, () => {
    for (const text of CORPUS) {
      assert.equal(
        decideTrigger({ text, smartMode }).fire,
        shouldAutoAssist(text, smartMode),
        `text=${JSON.stringify(text)} smartMode=${smartMode}`,
      );
    }
  });
}

test('smartMode defaults to on, mirroring the v0.6 default', () => {
  const text = 'The meeting starts in about ten minutes';
  assert.equal(decideTrigger({ text }).fire, shouldAutoAssist(text, true));
});

test('hotkey always fires, even with empty context', () => {
  const d = decideTrigger({ text: '', hotkey: true, smartMode: false });
  assert.equal(d.fire, true);
  assert.equal(d.reason, 'hotkey');
  assert.equal(decideTrigger({ text: 'hi', forceAssist: true }).fire, true);
});

test('the user\'s own speech never auto-fires', () => {
  const d = decideTrigger({ text: 'Can you send the deck by Friday?', channel: 'me' });
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'self-speech');
});

test('a repeated utterance is suppressed once it has been answered', () => {
  const text = 'Tell me about a time you led a project.';
  const first = decideTrigger({ text });
  assert.equal(first.fire, true);
  const second = decideTrigger({ text, lastFiredHash: first.hash });
  assert.equal(second.fire, false);
  assert.equal(second.reason, 'duplicate');
});

test('partials are marked speculative, finals are not', () => {
  const text = 'Tell me about a time you led a project.';
  assert.equal(decideTrigger({ text, isFinal: false }).speculative, true);
  assert.equal(decideTrigger({ text, isFinal: true }).speculative, false);
});

test('fired questions are labelled direct-question, other triggers meeting-cue', () => {
  assert.equal(decideTrigger({ text: 'What is a mutex?' }).reason, 'direct-question');
  assert.equal(
    decideTrigger({ text: 'The meeting starts in about ten minutes' }).reason,
    'meeting-cue',
  );
});

test('utteranceHash ignores case and whitespace noise but separates content', () => {
  assert.equal(
    utteranceHash('Tell  me about\nyourself'),
    utteranceHash('tell me about yourself'),
  );
  assert.notEqual(utteranceHash('What is a mutex?'), utteranceHash('What is a monitor?'));
});
