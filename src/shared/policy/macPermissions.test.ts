import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMicAccess,
  describeScreenAccess,
  normalizeAccessStatus,
  MIC_SETTINGS_URL,
  SCREEN_SETTINGS_URL,
} from './macPermissions.ts';

test('a granted screen permission allows capture without a prompt', () => {
  const verdict = describeScreenAccess('granted');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.needsPrompt, false);
  assert.equal(verdict.reason, undefined);
});

test('not-determined allows the first attempt because that raises the system prompt', () => {
  const verdict = describeScreenAccess('not-determined');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.needsPrompt, true);
});

test('a denied screen permission refuses capture and names the setting to change', () => {
  const verdict = describeScreenAccess('denied');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.needsPrompt, false);
  assert.match(verdict.reason ?? '', /Screen Recording/);
  assert.match(verdict.reason ?? '', /quit and reopen/);
});

test('restricted (MDM / parental controls) is treated as denial', () => {
  const verdict = describeScreenAccess('restricted');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /Screen Recording/);
});

test('unknown status stays permissive so non-macOS callers are unaffected', () => {
  assert.equal(describeScreenAccess('unknown').ok, true);
  assert.equal(describeScreenAccess(undefined).ok, true);
  assert.equal(describeScreenAccess('').ok, true);
  // Case and whitespace come from the OS/Electron as-is.
  assert.equal(describeScreenAccess(' GRANTED ').ok, true);
  assert.equal(describeScreenAccess(' DENIED ').ok, false);
});

test('microphone denial has its own message and does not mention screen recording', () => {
  const verdict = describeMicAccess('denied');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', /Microphone/);
  assert.doesNotMatch(verdict.reason ?? '', /Screen Recording/);
  assert.equal(describeMicAccess('granted').ok, true);
});

test('status normalization maps junk onto unknown', () => {
  assert.equal(normalizeAccessStatus('maybe'), 'unknown');
  assert.equal(normalizeAccessStatus(42), 'unknown');
  assert.equal(normalizeAccessStatus('Granted'), 'granted');
});

test('the deep links point at the two privacy panes', () => {
  assert.match(SCREEN_SETTINGS_URL, /Privacy_ScreenCapture$/);
  assert.match(MIC_SETTINGS_URL, /Privacy_Microphone$/);
});
