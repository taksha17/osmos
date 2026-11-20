import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTART_MAX_MS,
  evaluateWorkerHealth,
  nextRestartDelay,
  planWorkerCommand,
  type LivenessInput,
} from './workerRuntime.ts';

const electron = {
  isElectron: true,
  execPath: '/opt/OSMOS/osmos',
  systemNode: null,
  preferBundled: true,
};

test('bundled runtime wins in a packaged Electron app with no system node', () => {
  const launch = planWorkerCommand(electron);
  assert.ok(launch);
  assert.equal(launch.mode, 'bundled');
  assert.equal(launch.command, '/opt/OSMOS/osmos');
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
});

test('bundled still wins when a system node exists, unless the user forces system', () => {
  const withNode = { ...electron, systemNode: '/usr/bin/node' };
  assert.equal(planWorkerCommand(withNode)?.mode, 'bundled');

  const forced = planWorkerCommand({ ...withNode, preferBundled: false });
  assert.equal(forced?.mode, 'system');
  assert.equal(forced?.command, '/usr/bin/node');
  assert.deepEqual(forced?.env, {});
});

test('a dev host that already runs plain Node uses itself', () => {
  const launch = planWorkerCommand({
    isElectron: false,
    execPath: '/usr/bin/node',
    systemNode: '/usr/bin/node',
    preferBundled: true,
  });
  assert.equal(launch?.mode, 'system');
});

test('with no system node, a plain-Node host falls back to its own binary', () => {
  const launch = planWorkerCommand({
    isElectron: false,
    execPath: '/usr/bin/node',
    systemNode: null,
    preferBundled: true,
  });
  assert.equal(launch?.mode, 'bundled');
  assert.equal(launch?.command, '/usr/bin/node');
});

test('no binary at all is reported instead of guessed', () => {
  assert.equal(
    planWorkerCommand({ isElectron: false, execPath: '', systemNode: null, preferBundled: true }),
    null,
  );
});

test('restart backoff doubles and caps', () => {
  assert.equal(nextRestartDelay(0), 0);
  assert.equal(nextRestartDelay(1), 500);
  assert.equal(nextRestartDelay(2), 1000);
  assert.equal(nextRestartDelay(3), 2000);
  assert.equal(nextRestartDelay(20), RESTART_MAX_MS);
});

const base: LivenessInput = {
  state: 'ready',
  lastActivityAt: 1_000,
  startedAt: 0,
  now: 1_000,
  stallMs: 3_000,
  readyTimeoutMs: 10_000,
};

test('a chatty worker is healthy', () => {
  assert.equal(evaluateWorkerHealth({ ...base, now: 1_500 }), 'ok');
});

test('half the stall window is degraded, the full window restarts', () => {
  assert.equal(evaluateWorkerHealth({ ...base, now: 3_000 }), 'degraded');
  assert.equal(evaluateWorkerHealth({ ...base, now: 4_500 }), 'restart');
});

test('a worker that never becomes ready is restarted', () => {
  assert.equal(
    evaluateWorkerHealth({ ...base, state: 'starting', startedAt: 0, now: 9_000 }),
    'ok',
  );
  assert.equal(
    evaluateWorkerHealth({ ...base, state: 'starting', startedAt: 0, now: 11_000 }),
    'restart',
  );
});

test('stopped and crashed workers are ignored by the watchdog', () => {
  assert.equal(evaluateWorkerHealth({ ...base, state: 'stopped', now: 99_999 }), 'ignore');
  assert.equal(evaluateWorkerHealth({ ...base, state: 'crashed', now: 99_999 }), 'ignore');
});
