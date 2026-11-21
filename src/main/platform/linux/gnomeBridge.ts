/**
 * Ubuntu GNOME "stealth bridge" client (docs/UBUNTU-STEALTH-BRIDGE.md §6.2).
 *
 * The bridge is a GNOME Shell extension (linux/gnome-extension/…) that hides
 * every OSMOS window while a screen share or recording is active, because
 * GNOME/Wayland has no per-window capture-exclusion flag. It publishes state on
 * the session bus as `org.osmos.Bridge`; this module reads that state and owns
 * the installer/prefs entry points the app exposes.
 *
 * Rules this file must keep:
 * - Linux/GNOME only. `dbus-next` is imported lazily so Windows and macOS never
 *   load it, and so a build without the package degrades to "not installed".
 * - Absence is a normal state, not an error: OSMOS works as before and the UI
 *   says the overlay will be visible in shares.
 * - The D-Bus interface is read-only; changing the mode goes through the
 *   extension's own GSettings key (same schema the prefs window edits).
 */

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRIDGE_BUS_NAME,
  BRIDGE_OBJECT_PATH,
  BRIDGE_SCHEMA_ID,
  BRIDGE_UUID,
  normalizeBridgeMode,
  unsupportedBridgeState,
  type UbuntuBridgeMode,
  type UbuntuBridgeState,
} from '../../../shared/policy/ubuntuBridge.js';

type DbusInterface = {
  Ping: () => Promise<unknown>;
  on: (signal: string, callback: (...args: unknown[]) => void) => void;
};

type DbusProperties = {
  Get: (iface: string, property: string) => Promise<{ value: unknown }>;
};

type DbusProxyObject = {
  getInterface: (name: string) => unknown;
};

type DbusBus = {
  getProxyObject: (name: string, objectPath: string) => Promise<DbusProxyObject>;
  disconnect: () => void;
};

type DbusFactory = {
  sessionBus: () => DbusBus;
};

export type BridgeScriptResult = { ok: boolean; output: string };

const DBUS_PROPERTIES = 'org.freedesktop.DBus.Properties';
const DBUS_DAEMON = 'org.freedesktop.DBus';
const DBUS_DAEMON_PATH = '/org/freedesktop/DBus';

/**
 * GNOME only. Ubuntu sessions report `XDG_CURRENT_DESKTOP=ubuntu:GNOME`; a
 * plain `GNOME_DESKTOP_SESSION_ID` also counts. Matching `ubuntu` alone would
 * wrongly claim support on an Ubuntu box running another desktop.
 */
export function isGnomeSession(env: Record<string, string | undefined> = process.env): boolean {
  if (env.GNOME_DESKTOP_SESSION_ID) return true;
  const names = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.XDG_SESSION_DESKTOP ?? ''}`
    .toLowerCase()
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean);
  return names.includes('gnome');
}

function scriptResult(ok: boolean, output: string): BridgeScriptResult {
  return { ok, output };
}

function runBash(script: string): Promise<BridgeScriptResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        resolve(scriptResult(!error, output || (error ? error.message : '')));
      },
    );
  });
}

export class GnomeBridge extends EventEmitter {
  private readonly linuxRoot: string | null;
  private stateValue: UbuntuBridgeState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bus: DbusBus | null = null;
  private factory: DbusFactory | null = null;
  private iface: DbusInterface | null = null;
  private props: DbusProperties | null = null;
  private ownerIface: { on: (signal: string, cb: (...args: unknown[]) => void) => void } | null =
    null;
  private subscribed = false;
  private connecting = false;
  private dbusLoadFailed = false;

  constructor(linuxRoot: string | null) {
    super();
    this.linuxRoot = linuxRoot;
    const supported = process.platform === 'linux' && isGnomeSession();
    this.stateValue = supported
      ? {
          supported: true,
          installable: Boolean(linuxRoot),
          installed: false,
          sharing: false,
          mode: 'hide',
          version: '',
          transport: 'none',
          detail: 'Bridge not detected on the session bus yet.',
          checkedAt: Date.now(),
        }
      : unsupportedBridgeState(
          process.platform === 'linux'
            ? 'The Ubuntu bridge needs GNOME Shell; this desktop session is not GNOME.'
            : 'The Ubuntu bridge only runs on Linux with GNOME Shell.',
        );
  }

  getState(): UbuntuBridgeState {
    return this.stateValue;
  }

  /** Start polling; cheap when the bridge is absent, live signals once found. */
  start(): void {
    if (!this.stateValue.supported || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscribed = false;
    this.iface = null;
    this.props = null;
    this.ownerIface = null;
    if (this.bus) {
      try {
        this.bus.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.bus = null;
  }

  async refresh(): Promise<UbuntuBridgeState> {
    if (!this.stateValue.supported || this.connecting) return this.stateValue;
    this.connecting = true;
    try {
      await this.readBridge();
    } catch (error) {
      this.markMissing(error instanceof Error ? error.message : String(error));
    } finally {
      this.connecting = false;
    }
    return this.stateValue;
  }

  async install(): Promise<BridgeScriptResult> {
    const script = this.scriptPath('install-bridge.sh');
    if (!script) {
      return scriptResult(false, 'This build does not include linux/scripts/install-bridge.sh.');
    }
    const result = await runBash(script);
    await this.refresh();
    return result;
  }

  async uninstall(): Promise<BridgeScriptResult> {
    const script = this.scriptPath('uninstall-bridge.sh');
    if (!script) {
      return scriptResult(false, 'This build does not include linux/scripts/uninstall-bridge.sh.');
    }
    const result = await runBash(script);
    await this.refresh();
    return result;
  }

  /** Change the extension's own GSettings key; the Shell picks it up live. */
  async setMode(mode: UbuntuBridgeMode): Promise<{ ok: boolean; error?: string }> {
    const schemaDir = this.schemaDir();
    const args = schemaDir
      ? ['--schemadir', schemaDir, 'set', BRIDGE_SCHEMA_ID, 'mode', mode]
      : ['set', BRIDGE_SCHEMA_ID, 'mode', mode];
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      execFile('gsettings', args, { timeout: 10_000 }, (error, _stdout, stderr) => {
        if (error) resolve({ ok: false, error: (stderr || error.message).trim() });
        else resolve({ ok: true });
      });
    });
    if (result.ok) {
      await this.refresh();
      return result;
    }
    return {
      ok: false,
      error: result.error
        ? `${result.error} — install the bridge first, or change the mode in its settings window.`
        : 'Could not change the bridge mode.',
    };
  }

  async openPrefs(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      execFile(
        'gnome-extensions',
        ['prefs', BRIDGE_UUID],
        { timeout: 15_000 },
        (error, _stdout, stderr) => {
          if (error) resolve({ ok: false, error: (stderr || error.message).trim() });
          else resolve({ ok: true });
        },
      );
    });
  }

  private scriptPath(name: string): string | null {
    if (!this.linuxRoot) return null;
    const script = path.join(this.linuxRoot, 'scripts', name);
    return fs.existsSync(script) ? script : null;
  }

  private schemaDir(): string | null {
    const dataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
    const dir = path.join(dataHome, 'gnome-shell', 'extensions', BRIDGE_UUID, 'schemas');
    return fs.existsSync(path.join(dir, 'gschemas.compiled')) ? dir : null;
  }

  private async loadFactory(): Promise<DbusFactory | null> {
    if (this.factory) return this.factory;
    if (this.dbusLoadFailed) return null;
    try {
      const imported = (await import('dbus-next')) as unknown as DbusFactory & {
        default?: DbusFactory;
      };
      const factory = typeof imported.sessionBus === 'function' ? imported : imported.default;
      if (!factory || typeof factory.sessionBus !== 'function') {
        throw new Error('dbus-next has no sessionBus export');
      }
      this.factory = factory;
      return factory;
    } catch (error) {
      this.dbusLoadFailed = true;
      this.markMissing(
        `D-Bus client unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async readBridge(): Promise<void> {
    const factory = await this.loadFactory();
    if (!factory) return;
    const bus = this.bus ?? (this.bus = factory.sessionBus());

    const object = await bus.getProxyObject(BRIDGE_BUS_NAME, BRIDGE_OBJECT_PATH);
    const iface = object.getInterface(BRIDGE_BUS_NAME) as DbusInterface;
    const props = object.getInterface(DBUS_PROPERTIES) as DbusProperties;

    const [sharingValue, modeValue, versionValue] = await Promise.all([
      props.Get(BRIDGE_BUS_NAME, 'SharingActive'),
      props.Get(BRIDGE_BUS_NAME, 'Mode'),
      iface.Ping().catch(() => ''),
    ]);

    this.iface = iface;
    this.props = props;

    if (!this.subscribed) {
      this.subscribed = true;
      iface.on('SharingChanged', (active: unknown) => {
        this.set({ sharing: Boolean(active) });
      });
      await this.watchOwner(bus);
    }

    this.set({
      installed: true,
      sharing: Boolean(sharingValue?.value),
      mode: normalizeBridgeMode(modeValue?.value),
      version: typeof versionValue === 'string' ? versionValue : String(versionValue ?? ''),
      transport: 'dbus',
      detail: '',
    });
  }

  /** Notice the extension being disabled or the Shell restarting. */
  private async watchOwner(bus: DbusBus): Promise<void> {
    if (this.ownerIface) return;
    try {
      const object = await bus.getProxyObject(DBUS_DAEMON, DBUS_DAEMON_PATH);
      const iface = object.getInterface(DBUS_DAEMON) as {
        on: (signal: string, cb: (...args: unknown[]) => void) => void;
      };
      this.ownerIface = iface;
      iface.on('NameOwnerChanged', (name: unknown, _oldOwner: unknown, nextOwner: unknown) => {
        if (name === BRIDGE_BUS_NAME && !nextOwner) {
          this.markMissing(
            'The bridge left the session bus (extension disabled or Shell restarted).',
          );
        }
      });
    } catch {
      /* owner tracking is an optimisation; polling still recovers */
    }
  }

  private markMissing(detail: string): void {
    this.subscribed = false;
    this.iface = null;
    this.props = null;
    this.set({ installed: false, sharing: false, transport: 'none', version: '', detail });
  }

  private set(patch: Partial<UbuntuBridgeState>): void {
    const next: UbuntuBridgeState = { ...this.stateValue, ...patch, checkedAt: Date.now() };
    const keys: Array<keyof UbuntuBridgeState> = [
      'supported',
      'installable',
      'installed',
      'sharing',
      'mode',
      'version',
      'transport',
      'detail',
    ];
    const changed = keys.some((key) => next[key] !== this.stateValue[key]);
    this.stateValue = next;
    if (changed) this.emit('state', next);
  }
}

let singleton: GnomeBridge | null = null;

/** One client per process; `linuxRoot` is the app's bundled `linux/` directory. */
export function getGnomeBridge(linuxRoot: string | null): GnomeBridge {
  if (!singleton) singleton = new GnomeBridge(linuxRoot);
  return singleton;
}
