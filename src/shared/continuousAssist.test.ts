import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fusedAssistPrompt,
  latestUtterancePrompt,
  transcriptAssistPrompt,
} from './continuousAssist.ts';

test('fused assist carries the live transcript into the model prompt', () => {
  const prompt = fusedAssistPrompt({
    transcript: 'Which day is it today?',
    activeMode: 'interview',
  });
  assert.match(prompt, /Audio transcript:/);
  assert.match(prompt, /Which day is it today\?/);
  assert.match(prompt, /What should I say in response\?/);
});

test('manual overlay actions keep their instruction and add the transcript', () => {
  const prompt = transcriptAssistPrompt({
    instruction: 'Suggest 3 smart follow-up questions based on the conversation.',
    transcript: 'We shipped the migration on Friday.',
    activeMode: 'meeting',
  });
  assert.ok(prompt.startsWith('Suggest 3 smart follow-up questions'));
  assert.match(prompt, /Recent live meeting transcript/);
  assert.match(prompt, /We shipped the migration on Friday\./);
});

test('manual overlay actions stay clean when nothing has been heard', () => {
  assert.equal(
    transcriptAssistPrompt({
      instruction: 'Give me a brief recap.',
      transcript: '   ',
      activeMode: 'general',
    }),
    'Give me a brief recap.',
  );
});

test('the newest utterance is the only question manual Assist answers', () => {
  const prompt = latestUtterancePrompt({
    latest: 'How would you design a rate limiter for an API?',
    earlier: 'Which day is it today?\nYou can hear me clearly, right?',
    activeMode: 'interview',
  });
  assert.match(prompt, /Newest utterance:\n"How would you design a rate limiter/);
  assert.match(prompt, /do not answer these again/);
  assert.match(prompt, /Which day is it today\?/);
});

test('no newest utterance produces no prompt', () => {
  assert.equal(latestUtterancePrompt({ latest: '   ', activeMode: 'general' }), '');
});