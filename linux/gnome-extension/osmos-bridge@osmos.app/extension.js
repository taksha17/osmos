// OSMOS Stealth Bridge — GNOME Shell 46 (ES module) extension.
//
// Runs inside gnome-shell, the compositor process. It watches the Shell's
// remote-access controller — the same source GNOME uses for its own "you are
// sharing your screen" indicator — and hides every OSMOS window while a share
// or recording is active. It publishes that state on the session bus as
// org.osmos.Bridge so the app can show an honest status.
//
// It holds no secrets, makes no network calls, and reads only how many share
// handles exist, never their content. See docs/UBUNTU-STEALTH-BRIDGE.md.
//
// Why auto-hide instead of per-window capture exclusion: GNOME/Mutter has no
// per-window "exclude from capture" flag. Hiding is the compositor-level
// behaviour that is actually available today.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.osmos.Bridge';
const OBJ_PATH = '/org/osmos/Bridge';
const VERSION = '1';

const IFACE_XML = `
<node>
  <interface name="${BUS_NAME}">
    <method name="Ping">
      <arg type="s" direction="out" name="version"/>
    </method>
    <property name="SharingActive" type="b" access="read"/>
    <property name="Mode" type="s" access="read"/>
    <signal name="SharingChanged">
      <arg type="b" name="active"/>
    </signal>
  </interface>
</node>`;

export default class OsmosBridgeExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._handles = new Set(); // active share/record handles
    this._handleSignals = new Map(); // handle -> 'stopped' signal id
    this._hidden = new Set(); // window actors *we* hid, so we only restore those
    this._skipTaskbarSet = new Set(); // windows whose taskbar hint *we* changed
    this._actorSignals = new Map(); // actor -> [signal ids]
    this._windowSignals = new Map(); // Meta.Window -> [signal ids]
    this._timeouts = new Set(); // pending GLib sources
    this._settingIds = [];
    this._sharing = false;
    this._ctrl = null;
    this._newHandleId = 0;
    this._dbus = null;
    this._ownNameId = 0;

    this._exportDBus();
    this._hookRemoteAccess();

    this._settingIds = ['mode', 'app-ids', 'keep-above'].map((key) =>
      this._settings.connect(`changed::${key}`, () => this._apply()));

    this._createdId = global.display.connect('window-created', (_display, win) =>
      this._onWindowCreated(win));

    this._apply();
    console.log(`[osmos-bridge] enabled v${VERSION}`);
  }

  disable() {
    // 1. Stop reacting to anything.
    if (this._createdId) {
      global.display.disconnect(this._createdId);
      this._createdId = 0;
    }
    for (const id of this._settingIds) this._settings.disconnect(id);
    this._settingIds = [];

    if (this._ctrl && this._newHandleId) {
      try {
        this._ctrl.disconnect(this._newHandleId);
      } catch (_e) {
        /* controller gone */
      }
    }
    this._newHandleId = 0;
    this._ctrl = null;

    for (const [handle, id] of this._handleSignals) {
      try {
        handle.disconnect(id);
      } catch (_e) {
        /* handle gone */
      }
    }
    this._handleSignals.clear();
    this._handles.clear();
    this._sharing = false;

    for (const id of this._timeouts) GLib.source_remove(id);
    this._timeouts.clear();

    // 2. Restore only the windows we hid. A window the user hid stays hidden.
    for (const actor of Array.from(this._hidden)) {
      try {
        const win = actor.meta_window;
        if (win && !win.minimized) actor.show();
      } catch (_e) {
        /* destroyed */
      }
    }
    this._hidden.clear();
    for (const win of Array.from(this._skipTaskbarSet)) {
      try {
        win.set_skip_taskbar(false);
      } catch (_e) {
        /* destroyed or unsupported */
      }
    }
    this._skipTaskbarSet.clear();
    for (const actor of Array.from(this._actorSignals.keys())) this._disconnectActor(actor);
    this._actorSignals.clear();
    this._windowSignals.clear();

    // 3. Drop D-Bus last, so any final state read is still consistent.
    this._unexportDBus();
    this._settings = null;
    console.log('[osmos-bridge] disabled');
  }

  // ---------- screen-share detection ----------

  _hookRemoteAccess() {
    try {
      this._ctrl = global.backend?.get_remote_access_controller?.() ?? null;
    } catch (_e) {
      this._ctrl = null;
    }
    if (!this._ctrl) {
      console.warn(
        '[osmos-bridge] no remote-access controller on this Shell build; screen sharing cannot be detected',
      );
      return;
    }
    this._newHandleId = this._ctrl.connect('new-handle', (_ctrl, handle) => {
      this._handles.add(handle);
      const id = handle.connect('stopped', () => {
        try {
          handle.disconnect(id);
        } catch (_e) {
          /* already gone */
        }
        this._handleSignals.delete(handle);
        this._handles.delete(handle);
        this._updateSharing();
      });
      this._handleSignals.set(handle, id);
      this._updateSharing();
    });
    // LIMITATION: handles that existed before enable() are not listed. A share
    // already running when the extension starts is missed until the next one
    // (test T7.1 in the plan). Logged, not hidden, because the user is watching.
  }

  _updateSharing() {
    const active = this._handles.size > 0;
    if (active === this._sharing) return;
    this._sharing = active;
    console.log(`[osmos-bridge] sharing=${active}`);

    // Hide/show before announcing: the compositor is the latency-critical path,
    // and this narrows the first-frame race measured by test T4.
    this._apply();

    if (!this._dbus) return;
    try {
      this._dbus.emit_signal('SharingChanged', new GLib.Variant('(b)', [active]));
      this._dbus.emit_property_changed('SharingActive', new GLib.Variant('b', active));
    } catch (e) {
      console.warn(`[osmos-bridge] D-Bus emit failed: ${e}`);
    }
  }

  // ---------- window handling ----------

  _matches(win) {
    const wanted = new Set(this._settings.get_strv('app-ids').map((s) => s.toLowerCase()));
    if (wanted.size === 0) return false;
    const have = [
      win.get_gtk_application_id?.(),
      win.get_sandboxed_app_id?.(),
      win.get_wm_class?.(),
      win.get_wm_class_instance?.(),
    ];
    return have.some((value) => typeof value === 'string' && wanted.has(value.toLowerCase()));
  }

  _shouldHide() {
    return this._settings?.get_string('mode') === 'hide' && this._sharing;
  }

  _apply() {
    if (!this._settings) return;
    for (const actor of global.get_window_actors()) this._applyTo(actor);
  }

  _applyTo(actor) {
    if (!this._settings || !actor) return;
    const win = actor.meta_window;
    if (!win) return;

    if (!this._matches(win)) {
      this._restoreActor(actor, win);
      this._disconnectActor(actor);
      return;
    }

    const mode = this._settings.get_string('mode');
    if (mode === 'off') {
      this._restoreActor(actor, win);
      this._disconnectActor(actor);
      return;
    }

    if (this._settings.get_boolean('keep-above')) {
      if (!win.is_above()) win.make_above();
      if (!win.is_on_all_workspaces()) win.stick();
    }

    this._trackActor(actor, win);

    if (mode === 'hide' && this._sharing) {
      if (actor.visible) {
        actor.hide();
        this._hidden.add(actor);
      }
      this._hideFromSwitchers(win);
    } else {
      this._restoreActor(actor, win);
    }
  }

  /** Remember which actors we hid, and re-hide one that something re-shows. */
  _trackActor(actor, win) {
    if (!this._actorSignals.has(actor)) {
      const ids = [
        actor.connect('notify::visible', () => {
          if (this._shouldHide() && actor.visible) {
            actor.hide();
            this._hidden.add(actor);
          }
        }),
        actor.connect('destroy', () => {
          this._actorSignals.delete(actor);
          this._hidden.delete(actor);
          this._skipTaskbarSet.delete(win);
        }),
      ];
      this._actorSignals.set(actor, ids);
    }

    if (!this._windowSignals.has(win)) {
      const id = win.connect('notify::minimized', () => {
        const current = win.get_compositor_private?.();
        if (current) this._applyTo(current);
      });
      this._windowSignals.set(win, [id]);
    }
  }

  _restoreActor(actor, win) {
    if (this._hidden.delete(actor)) {
      try {
        if (win && !win.minimized) actor.show();
      } catch (_e) {
        /* destroyed */
      }
    }
    this._restoreSwitchers(win);
  }

  /**
   * Keep the window out of Alt-Tab, the Overview grid and — where the Shell
   * honours skip_taskbar — the dock, for the duration of the share. Guarded:
   * not every Mutter build exposes the setter, and a failure must never break
   * the hiding itself. A window that already has the hint (Electron's stealth
   * overlay) is left alone so its own setting survives the share.
   */
  _hideFromSwitchers(win) {
    try {
      if (typeof win.set_skip_taskbar !== 'function') return;
      if (win.is_skip_taskbar?.()) return;
      win.set_skip_taskbar(true);
      this._skipTaskbarSet.add(win);
    } catch (_e) {
      /* unsupported on this build */
    }
  }

  _restoreSwitchers(win) {
    if (!win || !this._skipTaskbarSet.delete(win)) return;
    try {
      win.set_skip_taskbar(false);
    } catch (_e) {
      /* destroyed */
    }
  }

  _disconnectActor(actor) {
    const ids = this._actorSignals.get(actor);
    if (ids) {
      for (const id of ids) {
        try {
          actor.disconnect(id);
        } catch (_e) {
          /* destroyed */
        }
      }
      this._actorSignals.delete(actor);
    }
    let win = null;
    try {
      win = actor.meta_window;
    } catch (_e) {
      win = null;
    }
    if (win) {
      const winIds = this._windowSignals.get(win);
      if (winIds) {
        for (const id of winIds) {
          try {
            win.disconnect(id);
          } catch (_e) {
            /* destroyed */
          }
        }
        this._windowSignals.delete(win);
      }
    }
  }

  _onWindowCreated(win) {
    // app id / wm_class may not be set at creation time; retry a few times.
    for (const delay of [50, 250, 1000]) {
      const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        this._timeouts.delete(id);
        if (!this._settings) return GLib.SOURCE_REMOVE;
        const actor = win.get_compositor_private?.();
        if (actor) this._applyTo(actor);
        return GLib.SOURCE_REMOVE;
      });
      this._timeouts.add(id);
    }
  }

  // ---------- D-Bus (read-only, session bus) ----------

  _exportDBus() {
    try {
      this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
      this._dbus.export(Gio.DBus.session, OBJ_PATH);
      this._ownNameId = Gio.bus_own_name_on_connection(
        Gio.DBus.session,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        null,
        null,
      );
    } catch (e) {
      console.warn(`[osmos-bridge] D-Bus export failed: ${e}`);
      this._dbus = null;
    }
  }

  _unexportDBus() {
    if (this._ownNameId) {
      try {
        Gio.bus_unown_name(this._ownNameId);
      } catch (_e) {
        /* already unowned */
      }
      this._ownNameId = 0;
    }
    if (this._dbus) {
      try {
        this._dbus.unexport();
      } catch (_e) {
        /* already gone */
      }
    }
    this._dbus = null;
  }

  // D-Bus members (wrapJSObject maps these by name).
  Ping() {
    return VERSION;
  }

  get SharingActive() {
    return this._sharing;
  }

  get Mode() {
    return this._settings?.get_string('mode') ?? 'off';
  }
}
