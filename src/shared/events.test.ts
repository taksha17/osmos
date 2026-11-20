import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedMs,
  eventsOfKind,
  isOsmosEvent,
  nowMs,
  parseEventLog,
  serializeEvent,
  type OsmosEvent,
} from './events.ts';

const sample: OsmosEvent[] = [
  { t: 'session.start', tsMs: 0, mode: 'interview', logVersion: 1 },
  {
    t: 'utterance.final',
    channel: 'them',
    text: 'Tell me about a time you led a project.',
    startMs: 10320,
    endMs: 13180,
  },
  { t: 'trigger.fire', tsMs: 13640, reason: 'direct-question' },
  {
    t: 'answer.done',
    tsMs: 15200,
    requestId: 'r1',
    stats: { firstTokenMs: 980, totalMs: 1560, lane: 'fast-local' },
  },
];

test('serialize + parse round-trips every event kind', () => {
  const log = sample.map(serializeEvent).join('');
  assert.deepEqual(parseEventLog(log), sample);
});

test('serializeEvent emits exactly one trailing newline', () => {
  const line = serializeEvent(sample[2]);
  assert.ok(line.endsWith('\n'));
  assert.equal(line.trimEnd().includes('\n'), false);
});

test('parseEventLog skips comments, blank lines, malformed JSON and unknown kinds', () => {
  const log = [
    '# a comment from a hand-written fixture',
    '',
    '   ',
    '{"t":"utterance.final","channel":"them",',
    '{"t":"not.an.event","tsMs":1}',
    JSON.stringify(sample[2]),
    'null',
    '42',
  ].join('\r\n');
  assert.deepEqual(parseEventLog(log), [sample[2]]);
});

test('parseEventLog tolerates a missing or non-string body', () => {
  assert.deepEqual(parseEventLog(undefined as unknown as string), []);
  assert.deepEqual(parseEventLog(''), []);
});

test('isOsmosEvent rejects non-objects and unknown kinds', () => {
  assert.equal(isOsmosEvent(null), false);
  assert.equal(isOsmosEvent('utterance.final'), false);
  assert.equal(isOsmosEvent({ t: 'bogus' }), false);
  assert.equal(isOsmosEvent({ t: 'worker.status', worker: 'stt', state: 'ready', tsMs: 1 }), true);
});

test('eventsOfKind narrows to the requested kind in order', () => {
  const found = eventsOfKind(sample, 'trigger.fire');
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, 'direct-question');
  assert.deepEqual(eventsOfKind(sample, 'screen.snapshot'), []);
});

test('nowMs is monotonic and elapsedMs never goes negative', () => {
  const a = nowMs();
  const b = nowMs();
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
  assert.ok(b >= a);
  assert.ok(elapsedMs(a) >= 0);
});
