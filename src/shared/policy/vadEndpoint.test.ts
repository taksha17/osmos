import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EndpointDetector,
  FRAME_BYTES_16K_MONO,
  VAD_DEFAULTS,
  splitFrames,
  type VadEvent,
} from './vadEndpoint.ts';

const FRAME_MS = 20;
const LOUD = 0.2;
const QUIET = 0.001;

/** Feed [ms, rms] segments and collect the events with their timestamps. */
function run(segments: Array<[number, number]>, params = {}) {
  const detector = new EndpointDetector(params);
  const events: Array<VadEvent & { at: number }> = [];
  let t = 0;
  for (const [ms, rms] of segments) {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      t += FRAME_MS;
      for (const event of detector.push(rms, t)) events.push({ ...event, at: t });
    }
  }
  return { events, detector, t };
}

test('continuous silence produces nothing', () => {
  const { events } = run([[2_000, QUIET]]);
  assert.deepEqual(events, []);
});

test('a 100 ms blip is below minSpeechMs and is dropped', () => {
  const { events } = run([
    [500, QUIET],
    [100, LOUD],
    [1_000, QUIET],
  ]);
  assert.deepEqual(events, []);
});

test('speech then 450 ms of silence produces start and endpoint', () => {
  const { events } = run([
    [400, QUIET],
    [600, LOUD],
    [600, QUIET],
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].t, 'utterance.start');
  assert.equal(events[1].t, 'utterance.end');
  if (events[1].t !== 'utterance.end') return;
  assert.equal(events[1].reason, 'endpoint');
  assert.ok(events[1].speechMs >= 560 && events[1].speechMs <= 640, `speechMs=${events[1].speechMs}`);
});

test('start timestamp includes the pre-roll so the first syllable is kept', () => {
  const { events } = run([
    [400, QUIET],
    [400, LOUD],
    [600, QUIET],
  ]);
  const start = events.find((e) => e.t === 'utterance.start');
  assert.ok(start);
  if (start.t !== 'utterance.start') return;
  // 400 ms of silence first, so the first loud frame lands at t = 420 ms.
  const firstVoiceAt = 420;
  assert.equal(start.startMs, firstVoiceAt - VAD_DEFAULTS.preRollMs);
  // Announced once minSpeechMs of voice has arrived; at frame granularity the
  // last frame that completes the window may still be inside it.
  assert.ok(
    start.atMs >= firstVoiceAt + VAD_DEFAULTS.minSpeechMs - VAD_DEFAULTS.frameMs,
  );
  assert.ok(start.atMs <= firstVoiceAt + VAD_DEFAULTS.minSpeechMs + VAD_DEFAULTS.frameMs);
});

test('a pause shorter than the hangover does not end the utterance', () => {
  const { events, detector } = run([
    [400, LOUD],
    [300, QUIET],
    [400, LOUD],
    [600, QUIET],
  ]);
  assert.equal(events.filter((e) => e.t === 'utterance.start').length, 1);
  assert.equal(events.filter((e) => e.t === 'utterance.end').length, 1);
  assert.equal(detector.currentState, 'silence');
});

test('a monologue past maxUtteranceMs is flushed and a new utterance starts', () => {
  const { events } = run([[26_000, LOUD]], { maxUtteranceMs: 5_000 });
  const ends = events.filter((e) => e.t === 'utterance.end');
  const starts = events.filter((e) => e.t === 'utterance.start');
  assert.ok(ends.length >= 2, `ends=${ends.length}`);
  assert.equal(starts.length, ends.length + 1);
  assert.equal(ends[0].t === 'utterance.end' && ends[0].reason, 'max-length');
});

test('flush closes an in-flight utterance and resets the detector', () => {
  const detector = new EndpointDetector();
  for (let i = 1; i <= 20; i++) detector.push(LOUD, i * FRAME_MS);
  assert.equal(detector.currentState, 'speech');
  const events = detector.flush(999);
  assert.equal(events.length, 1);
  assert.equal(events[0].t, 'utterance.end');
  assert.equal(detector.currentState, 'silence');
  assert.deepEqual(detector.flush(1_000), []);
});

test('threshold is honoured on the boundary frames', () => {
  const detector = new EndpointDetector({ speechThreshold: 0.05 });
  for (let i = 1; i <= 20; i++) detector.push(0.049, i * FRAME_MS);
  assert.equal(detector.currentState, 'silence');
  detector.push(0.05, 500);
  assert.equal(detector.currentState, 'speech');
});

test('splitFrames keeps a remainder for the next block', () => {
  const buffer = Buffer.alloc(FRAME_BYTES_16K_MONO * 3 + 100, 7);
  const { frames, rest } = splitFrames(buffer, FRAME_BYTES_16K_MONO);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].length, FRAME_BYTES_16K_MONO);
  assert.equal(rest.length, 100);
});

test('defaults match the RFC parameter table', () => {
  assert.equal(VAD_DEFAULTS.frameMs, 20);
  assert.equal(VAD_DEFAULTS.minSpeechMs, 250);
  assert.equal(VAD_DEFAULTS.endpointHangoverMs, 450);
  assert.equal(VAD_DEFAULTS.maxUtteranceMs, 25_000);
  assert.equal(VAD_DEFAULTS.preRollMs, 300);
});
