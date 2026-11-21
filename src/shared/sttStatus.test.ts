import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSttStatusLine } from './sttStatus.ts';

test('hook status lines are recognised', () => {
  for (const s of [
    '🎙 starting mic…',
    '🎙 listening…',
    '👁 watching the screen',
    'Starting meeting audio…',
    'Listening to system audio…',
    'Listening (Windows loopback)…',
    'Transcribing…',
    'Transcribing meeting audio…',
    'Transcribing (queue)…',
    'reconnecting…',
    'System audio worker ready',
    'System audio worker ready…',
    'Mic worker is ready',
    'No laptop audio — play media on THIS machine (TV/phone audio won’t appear)',
  ]) {
    assert.equal(isSttStatusLine(s), true, s);
  }
});

test('real speech that opens with a status word is kept', () => {
  for (const s of [
    'Recording the meeting is fine with me.',
    'Audio quality on that call was poor.',
    'Listening is the hardest part of the job.',
    'Mic check, one two three.',
    'Starting next Monday, I can join full-time.',
    'Transcribing every interview is a privacy question.',
    'Device drivers came up in the system design round.',
    'Ready to ship the migration by Friday.',
  ]) {
    assert.equal(isSttStatusLine(s), false, s);
  }
});

test('empty input is not a status', () => {
  assert.equal(isSttStatusLine(''), false);
  assert.equal(isSttStatusLine('   '), false);
});
