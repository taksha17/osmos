import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFatalMicError, isFatalSystemAudioError } from './audioRecovery.ts';

test('system-audio fatal errors cover Windows, macOS and Linux', () => {
  const fatal = [
    'Windows has no active playback device, so system audio cannot be captured.',
    'Windows loopback stream had no audio track.',
    'Desktop capture was blocked. Allow screen/audio capture for OSMOS.',
    'macOS meeting audio needs a virtual loopback. Install BlackHole (https://existential.audio/blackhole/).',
    'No sink monitor found for system audio.',
    'Windows system audio capture failed. Play audio on speakers and use Smart listen from the overlay.',
  ];
  for (const message of fatal) {
    assert.equal(isFatalSystemAudioError(message), true, message);
  }
});

test('a transient system-audio failure stays retryable', () => {
  for (const message of [
    'System audio capture timed out',
    'fetch failed',
    'The operation was aborted',
    'Listening (chunked capture)…',
  ]) {
    assert.equal(isFatalSystemAudioError(message), false, message);
  }
});

test('mic fatal errors cover Windows, macOS and Linux', () => {
  const fatal = [
    'No DirectShow microphones found. Check Windows Settings → Microphone.',
    'No AVFoundation audio inputs found. Grant Microphone permission.',
    'No usable microphone found. Check Settings → Speech.',
    'No microphone source found. Check Settings → Speech → Microphone.',
    'Main-process mic streaming unavailable.',
    'Continuous mic streaming is not supported on win32.',
    'ffmpeg was not found. Install it or use the bundled binary.',
  ];
  for (const message of fatal) {
    assert.equal(isFatalMicError(message), true, message);
  }
});

test('a transient mic failure stays retryable', () => {
  for (const message of [
    'Mic listen failed',
    'Mic stream error',
    'ffmpeg exited with code 1',
    '',
  ]) {
    assert.equal(isFatalMicError(message), false, message);
  }
});
