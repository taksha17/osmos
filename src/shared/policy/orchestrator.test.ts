import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLanes } from './routerV2.ts';
import {
  DEFAULT_DEADLINE_MS,
  UNCHANGED_EDIT_RATIO,
  createOrchestrator,
  editDistanceRatio,
  type OrchestratorAction,
} from './orchestrator.ts';

const STRONG_PARTIAL = 'Tell me about a time you led a proj';
const STRONG_FINAL = 'Tell me about a time you led a project.';

function types(actions: OrchestratorAction[]): string[] {
  return actions.map((action) => action.type);
}

test('editDistanceRatio is 0 for the same text modulo case and punctuation', () => {
  assert.equal(editDistanceRatio('What is a mutex?', 'what  is a MUTEX'), 0);
  assert.equal(editDistanceRatio('', ''), 0);
  assert.equal(editDistanceRatio('', 'something'), 1);
});

test('editDistanceRatio grows with real content changes', () => {
  const small = editDistanceRatio(STRONG_PARTIAL, STRONG_FINAL);
  const large = editDistanceRatio(STRONG_PARTIAL, 'What is a mutex?');
  assert.ok(small <= UNCHANGED_EDIT_RATIO, String(small));
  assert.ok(large > UNCHANGED_EDIT_RATIO, String(large));
});

test('a confident partial starts a speculative request on the planned lane', () => {
  const orchestrator = createOrchestrator();
  const actions = orchestrator.partial({ text: STRONG_PARTIAL, nowMs: 1_000 });
  assert.deepEqual(types(actions), ['start']);
  const start = actions[0];
  assert.equal(start.type, 'start');
  if (start.type !== 'start') return;
  assert.equal(start.speculative, true);
  assert.equal(start.requestId, 'r1');
  assert.equal(start.lane, planLanes({ question: STRONG_PARTIAL }).primary);
  assert.deepEqual(start.tiers, ['fast', 'quality']);
});

test('a weak partial waits for the final', () => {
  const orchestrator = createOrchestrator();
  const actions = orchestrator.partial({ text: 'Okay so the plan is to shi', nowMs: 0 });
  assert.deepEqual(types(actions), ['ignore']);
  assert.equal(orchestrator.state().inFlight, null);
});

test('an unchanged final keeps the draft streaming', () => {
  const orchestrator = createOrchestrator();
  orchestrator.partial({ text: STRONG_PARTIAL, nowMs: 0 });
  const actions = orchestrator.final({ text: STRONG_FINAL, nowMs: 400 });
  assert.deepEqual(types(actions), ['keep']);
  const keep = actions[0];
  assert.equal(keep.type, 'keep');
  if (keep.type !== 'keep') return;
  assert.equal(keep.requestId, 'r1');
  assert.ok(keep.editRatio <= UNCHANGED_EDIT_RATIO);
  assert.equal(orchestrator.state().inFlight?.speculative, false);
});

test('a materially different final cancels the draft and restarts', () => {
  const orchestrator = createOrchestrator();
  orchestrator.partial({ text: STRONG_PARTIAL, nowMs: 0 });
  const actions = orchestrator.final({ text: 'What is a mutex?', nowMs: 500 });
  assert.deepEqual(types(actions), ['cancel', 'restart']);
  const restart = actions[1];
  assert.equal(restart.type, 'restart');
  if (restart.type !== 'restart') return;
  assert.equal(restart.previousRequestId, 'r1');
  assert.equal(restart.requestId, 'r2');
  assert.equal(orchestrator.state().inFlight?.requestId, 'r2');
});

test('a final that is no longer a question drops the draft', () => {
  const orchestrator = createOrchestrator();
  orchestrator.partial({ text: STRONG_PARTIAL, nowMs: 0 });
  const actions = orchestrator.final({
    text: 'Okay so the plan is to ship on Thursday afternoon',
    nowMs: 600,
  });
  assert.deepEqual(types(actions), ['cancel', 'ignore']);
  assert.equal(orchestrator.state().inFlight, null);
});

test('a newer question supersedes an answer that is still streaming', () => {
  const orchestrator = createOrchestrator();
  const first = orchestrator.final({ text: 'What is a mutex?', nowMs: 0 });
  assert.deepEqual(types(first), ['start']);
  const actions = orchestrator.final({ text: 'How does HTTPS work?', nowMs: 900 });
  assert.deepEqual(types(actions), ['cancel', 'start']);
  const cancel = actions[0];
  assert.equal(cancel.type, 'cancel');
  if (cancel.type === 'cancel') assert.equal(cancel.reason, 'superseded');
  assert.equal(orchestrator.state().inFlight?.requestId, 'r2');
});

test('the same question inside the cooldown does not re-fire', () => {
  const orchestrator = createOrchestrator();
  orchestrator.final({ text: 'What is a mutex?', nowMs: 0 });
  const repeat = orchestrator.final({ text: 'What is a mutex?', nowMs: 2_000 });
  assert.deepEqual(types(repeat), ['ignore']);
  const later = orchestrator.final({ text: 'What is a mutex?', nowMs: 30_000 });
  assert.deepEqual(types(later), ['cancel', 'start']);
});

test('a meeting cue becomes a note', () => {
  const orchestrator = createOrchestrator();
  const actions = orchestrator.final({ text: 'We should probably revisit the pricing page copy', nowMs: 0 });
  assert.deepEqual(types(actions), ['note']);
  assert.equal(orchestrator.state().inFlight, null);
});

test('the hotkey always answers and supersedes anything live', () => {
  const orchestrator = createOrchestrator();
  orchestrator.final({ text: 'What is a mutex?', nowMs: 0 });
  const actions = orchestrator.hotkey({ text: '', nowMs: 300 });
  assert.deepEqual(types(actions), ['cancel', 'start']);
  assert.equal(orchestrator.state().inFlight?.requestId, 'r2');
});

test('a request past its deadline is cancelled once', () => {
  const orchestrator = createOrchestrator();
  orchestrator.final({ text: 'What is a mutex?', nowMs: 0 });
  assert.deepEqual(types(orchestrator.checkDeadline(DEFAULT_DEADLINE_MS - 1)), []);
  const expired = orchestrator.checkDeadline(DEFAULT_DEADLINE_MS);
  assert.deepEqual(types(expired), ['cancel']);
  const cancel = expired[0];
  assert.equal(cancel.type, 'cancel');
  if (cancel.type === 'cancel') assert.equal(cancel.reason, 'deadline');
  assert.deepEqual(orchestrator.checkDeadline(DEFAULT_DEADLINE_MS + 1_000), []);
});

test('completing a request frees the lane for the next question', () => {
  const orchestrator = createOrchestrator();
  const started = orchestrator.final({ text: 'What is a mutex?', nowMs: 0 });
  const start = started[0];
  assert.equal(start.type, 'start');
  if (start.type !== 'start') return;
  assert.equal(orchestrator.complete(start.requestId), true);
  assert.equal(orchestrator.complete('nope'), false);
  assert.equal(orchestrator.state().inFlight, null);
});

test('a second partial while a draft is streaming is ignored', () => {
  const orchestrator = createOrchestrator();
  orchestrator.partial({ text: STRONG_PARTIAL, nowMs: 0 });
  const actions = orchestrator.partial({ text: `${STRONG_PARTIAL}ect`, nowMs: 200 });
  assert.deepEqual(types(actions), ['ignore']);
  assert.equal(orchestrator.state().inFlight?.requestId, 'r1');
});

test('the coding screen is offered as a note, never auto-answered', () => {
  const orchestrator = createOrchestrator();
  const problem = 'Given an array of integers, return the indices of the two numbers that add up to target.';
  const actions = orchestrator.final({ text: problem, mode: 'coding', codingScreen: true, nowMs: 0 });
  assert.deepEqual(types(actions), ['note']);
  assert.equal(orchestrator.state().inFlight, null);
});
