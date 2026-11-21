import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeSummary,
  isBridgeMode,
  normalizeBridgeMode,
  unsupportedBridgeState,
  type UbuntuBridgeState,
} from './ubuntuBridge.ts';

function state(patch: Partial<UbuntuBridgeState> = {}): UbuntuBridgeState {
  return {
    supported: true,
    installable: true,
    installed: true,
    sharing: false,
    mode: 'hide',
    version: '1',
    transport: 'dbus',
    detail: '',
    checkedAt: 0,
    ...patch,
  };
}

test('bridge modes are validated instead of coerced', () => {
  assert.equal(isBridgeMode('hide'), true);
  assert.equal(isBridgeMode('off'), true);
  assert.equal(isBridgeMode('always'), false);
  assert.equal(normalizeBridgeMode('keep'), 'keep');
  // A corrupt settings value must never select the "keep" test mode.
  assert.equal(normalizeBridgeMode('yes'), 'hide');
  assert.equal(normalizeBridgeMode(undefined), 'hide');
});

test('non-GNOME hosts are reported as unsupported, not as protected', () => {
  const summary = bridgeSummary(unsupportedBridgeState('windows'));
  assert.equal(summary.tone, 'idle');
  assert.match(summary.label, /Not available/);
  assert.doesNotMatch(summary.detail, /hidden/i);
});

test('a missing bridge warns that the overlay is visible in shares', () => {
  const summary = bridgeSummary(state({ installed: false, transport: 'none' }));
  assert.equal(summary.tone, 'warn');
  assert.match(summary.label, /not installed/i);
  assert.match(summary.detail, /visible in a full-screen share/);
  assert.match(summary.detail, /log out and back in/);
});

test('a missing bridge with no installer points at the repository script', () => {
  const summary = bridgeSummary(state({ installed: false, installable: false }));
  assert.match(summary.detail, /install-bridge\.sh/);
});

test('an active share in hide mode reads as hidden', () => {
  const summary = bridgeSummary(state({ sharing: true, mode: 'hide' }));
  assert.equal(summary.tone, 'ok');
  assert.match(summary.label, /Hidden for this share/);
  assert.match(summary.detail, /returns when the share ends/);
});

test('keep mode during a share is a warning, never a pass', () => {
  const summary = bridgeSummary(state({ sharing: true, mode: 'keep' }));
  assert.equal(summary.tone, 'warn');
  assert.match(summary.label, /still visible/);
  assert.match(summary.detail, /testing only/);
});

test('off mode during a share warns that nothing is hidden', () => {
  const summary = bridgeSummary(state({ sharing: true, mode: 'off' }));
  assert.equal(summary.tone, 'warn');
  assert.match(summary.detail, /nothing is hidden/);
});

test('an installed idle bridge is only claimed to be watching, not hiding', () => {
  const summary = bridgeSummary(state());
  assert.equal(summary.tone, 'ok');
  assert.match(summary.label, /watching for shares/);
  assert.match(summary.detail, /hides automatically/);
});

test('off mode outside a share is idle rather than a warning', () => {
  assert.equal(bridgeSummary(state({ mode: 'off' })).tone, 'idle');
});
