/**
 * D-Bus contract probe for the Ubuntu stealth bridge
 * (docs/UBUNTU-STEALTH-BRIDGE.md §11, "D-Bus contract test").
 *
 * Runs under `dbus-run-session`, exports a mock `org.osmos.Bridge` with the same
 * interface the GNOME extension exports, then drives the shipped client
 * (`src/main/platform/linux/gnomeBridge.ts`) against it. This proves the
 * contract — Ping, both properties, the SharingChanged signal, and name loss —
 * without needing a Shell restart.
 *
 * It cannot prove that GNOME hides windows during a real share; that stays
 * untested until the T3–T5 rows in docs/STEALTH-MATRIX.md are measured.
 */

import { createRequire } from 'node:module';
import { GnomeBridge } from '../src/main/platform/linux/gnomeBridge.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbus = require('dbus-next') as any;

class BridgeMock extends dbus.interface.Interface {
  sharing = false;
  mode = 'hide';

  constructor() {
    super('org.osmos.Bridge');
  }

  Ping() {
    return '1';
  }

  get SharingActive() {
    return this.sharing;
  }

  get Mode() {
    return this.mode;
  }

  // Wrapped by configureMembers into the real D-Bus signal.
  SharingChanged(value: boolean) {
    return value;
  }
}

BridgeMock.configureMembers({
  properties: {
    SharingActive: { signature: 'b', access: dbus.interface.ACCESS_READ },
    Mode: { signature: 's', access: dbus.interface.ACCESS_READ },
  },
  methods: {
    Ping: { inSignature: '', outSignature: 's' },
  },
  signals: {
    SharingChanged: { signature: 'b' },
  },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  const bus = dbus.sessionBus();
  const mock = new BridgeMock();
  bus.export('/org/osmos/Bridge', mock);
  const requested = await bus.requestName('org.osmos.Bridge', 0);
  assert(requested === 1, `requestName returned ${requested}, expected PRIMARY_OWNER (1)`);

  const bridge = new GnomeBridge(null);
  const checks: Record<string, boolean> = {};

  try {
    const first = await bridge.refresh();
    checks.installed = first.installed;
    checks.transport = first.transport === 'dbus';
    checks.version = first.version === '1';
    checks.mode = first.mode === 'hide';
    checks.idle = first.sharing === false;
    assert(first.installed, 'the client did not see the mock bridge on the bus');
    assert(first.transport === 'dbus', `transport was ${first.transport}`);
    assert(first.version === '1', `Ping returned ${JSON.stringify(first.version)}`);
    assert(first.mode === 'hide', `Mode was ${first.mode}`);
    assert(!first.sharing, 'a fresh bridge should report sharing=false');

    // Property re-read (what the app polls every 3 s).
    mock.mode = 'keep';
    const modeChanged = await bridge.refresh();
    checks.modeReread = modeChanged.mode === 'keep';
    assert(modeChanged.mode === 'keep', `Mode after change was ${modeChanged.mode}`);

    // The signal path the app uses to react inside ~200 ms.
    mock.sharing = true;
    mock.SharingChanged(true);
    await waitFor(() => bridge.getState().sharing, 'SharingChanged(true) was not delivered');
    checks.sharingSignal = true;

    mock.sharing = false;
    mock.SharingChanged(false);
    await waitFor(() => !bridge.getState().sharing, 'SharingChanged(false) was not delivered');
    checks.sharingStopped = true;

    // Extension disabled / Shell restarted: the bus name disappears and the
    // client must stop claiming the overlay is protected.
    await bus.releaseName('org.osmos.Bridge');
    await waitFor(
      () => !bridge.getState().installed,
      'NameOwnerChanged did not mark the bridge as gone',
    );
    checks.nameLoss = true;

    process.stdout.write(`UBUNTU_BRIDGE_PROBE ${JSON.stringify({ ok: true, checks })}\n`);
  } finally {
    bridge.stop();
    try {
      bus.disconnect();
    } catch {
      /* already gone */
    }
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `UBUNTU_BRIDGE_PROBE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
