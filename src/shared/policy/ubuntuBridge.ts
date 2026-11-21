/**
 * Ubuntu "stealth bridge" contract (docs/UBUNTU-STEALTH-BRIDGE.md).
 *
 * GNOME/Wayland has no per-window "exclude from capture" flag, so OSMOS cannot
 * use the Windows/macOS approach on Ubuntu. Instead a small GNOME Shell
 * extension (the bridge) watches the Shell's remote-access controller and hides
 * every OSMOS window while a share or recording is active.
 *
 * This module is the pure half: the state shape, the D-Bus names, and the one
 * function the UI uses to describe that state. It stays free of Electron and of
 * `dbus-next` so both the main process and the renderer can import it, and so it
 * can be unit tested without a desktop session.
 */

export type UbuntuBridgeMode = 'hide' | 'keep' | 'off';

/** Raw state as reported by the main-process D-Bus client. */
export type UbuntuBridgeState = {
  /** True only on Linux/GNOME, where a Shell extension can run. */
  supported: boolean;
  /** This build can run the installer (the `linux/` assets are present). */
  installable: boolean;
  /** The extension currently owns `org.osmos.Bridge` on the session bus. */
  installed: boolean;
  /** A screen share or recording is active right now. */
  sharing: boolean;
  mode: UbuntuBridgeMode;
  /** Bridge protocol version reported by `Ping`; '' when unknown. */
  version: string;
  /** How the state was learned. `none` means no bridge was reachable. */
  transport: 'dbus' | 'none';
  /** Raw explanation (D-Bus error, missing assets, …) for support reports. */
  detail: string;
  checkedAt: number;
};

export const BRIDGE_UUID = 'osmos-bridge@osmos.app';
export const BRIDGE_BUS_NAME = 'org.osmos.Bridge';
export const BRIDGE_OBJECT_PATH = '/org/osmos/Bridge';
export const BRIDGE_SCHEMA_ID = 'org.gnome.shell.extensions.osmos-bridge';

export function isBridgeMode(value: unknown): value is UbuntuBridgeMode {
  return value === 'hide' || value === 'keep' || value === 'off';
}

/** Junk from a stale settings file must not silently enable "keep" mode. */
export function normalizeBridgeMode(value: unknown): UbuntuBridgeMode {
  return isBridgeMode(value) ? value : 'hide';
}

/** State for hosts that cannot run the bridge at all (macOS, Windows, no GNOME). */
export function unsupportedBridgeState(detail: string, installable = false): UbuntuBridgeState {
  return {
    supported: false,
    installable,
    installed: false,
    sharing: false,
    mode: 'off',
    version: '',
    transport: 'none',
    detail,
    checkedAt: Date.now(),
  };
}

export type BridgeTone = 'ok' | 'warn' | 'idle';

export type BridgeSummary = {
  tone: BridgeTone;
  /** Short status for a chip or list row. */
  label: string;
  /** One sentence the user can act on. */
  detail: string;
};

/**
 * The single place the bridge is described to the user.
 *
 * Honesty rules (docs/UBUNTU-STEALTH-BRIDGE.md §0/§8): this is *auto-hide during
 * sharing*, not "visible to me, invisible to the capture"; the setup card must
 * appear when the bridge is missing, and an untested/absent state must never
 * read as "protected".
 */
export function bridgeSummary(state: UbuntuBridgeState): BridgeSummary {
  if (!state.supported) {
    return {
      tone: 'idle',
      label: 'Not available on this platform',
      detail:
        'The Ubuntu bridge needs Linux with GNOME Shell. Windows and macOS use their OS capture-exclusion flag instead.',
    };
  }

  if (!state.installed) {
    return {
      tone: 'warn',
      label: 'Bridge not installed',
      detail: state.installable
        ? 'The overlay stays visible in a full-screen share. Install the bridge, then log out and back in.'
        : 'This build has no bridge installer. Run linux/scripts/install-bridge.sh from the repository, then log out and back in.',
    };
  }

  if (state.sharing) {
    if (state.mode === 'hide') {
      return {
        tone: 'ok',
        label: 'Hidden for this share',
        detail: 'The compositor hid every OSMOS window when the share started. It returns when the share ends.',
      };
    }
    if (state.mode === 'keep') {
      return {
        tone: 'warn',
        label: 'Sharing — overlay still visible',
        detail: 'Mode is "keep" (testing only). Set it to "hide" before a real meeting.',
      };
    }
    return {
      tone: 'warn',
      label: 'Sharing — bridge is off',
      detail: 'Mode is "off": nothing is hidden and nothing is pinned.',
    };
  }

  if (state.mode === 'off') {
    return {
      tone: 'idle',
      label: 'Installed — disabled',
      detail: 'Mode is "off". OSMOS neither hides nor pins the overlay.',
    };
  }

  if (state.mode === 'keep') {
    return {
      tone: 'warn',
      label: 'Installed — keep mode',
      detail: 'The overlay will stay visible in shares. Switch to "hide" for real meetings.',
    };
  }

  return {
    tone: 'ok',
    label: 'Installed — watching for shares',
    detail: 'The overlay hides automatically while a screen share or recording is active.',
  };
}
