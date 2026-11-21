# Stealth verification matrix

Architecture v2 §11. A row is only marked **pass** when it was produced by a
script or an interactive run on that OS, with the versions recorded. Anything not
run is labelled **untested** — the UI must not imply otherwise.

## How a row is produced

```bash
npm run probe:stealth     # bundles scripts/stealth-probe-main.ts and runs it under Electron
```

The probe drives the shipped helper (`src/main/services/stealthWindow.ts`), not a
copy: it creates a meeting window and a transparent overlay, shows the overlay
with `presentOverlay`, and reports a JSON line with one key per check. It exits
non-zero when a product check fails.

Checks:

| Check | Meaning |
|---|---|
| `overlayDidNotStealFocus` | the overlay is not focused immediately after it is shown |
| `meetingKeptFocus` | the window underneath still holds focus |
| `overlayTakesFocusOnClick` | the click path (`focusOverlay`) does activate it |
| `passiveAfterFocusRelease` | after the blur path the overlay is not focusable |
| `toolWindowStyle` | `WS_EX_TOOLWINDOW` is set (keeps it out of Alt-Tab) |
| `contentProtectionApiAccepted` | `setContentProtection(true)` did not throw |
| `exclusionEnvironmentLimited` | capture exclusion could not be observed here (see below) |
| `screenCaptureUsable` | a control screen grab showed real pixels, so pixel tests are meaningful |
| `clickThroughUnfocusable` | click-through leaves the window non-focusable |

## Measured rows

### Windows 11 Home — 2026-11-21

`Electron 34.5.8` · `Node 20.19.1` · test box (`TAKSHA-DESKTOP`),
driven over SSH.

| Concern | Result | Evidence |
|---|---|---|
| Excluded from capture | **mechanism wired, unverified here** | `setContentProtection(true)` accepted; `WDA_EXCLUDEFROMCAPTURE` could not be confirmed because the SSH-attached desktop is not composited (`GetWindowDisplayAffinity` = 0, GDI capture black, GPU process exiting) |
| Don't steal focus | **pass** | `overlayDidNotStealFocus=true`, `meetingKeptFocus=true` |
| Focus on click | **pass** | `overlayTakesFocusOnClick=true` |
| Return to passive on blur | **pass** | `passiveAfterFocusRelease=true` (an SSH session cannot move foreground focus, so the blur *event* never fires; the probe runs the handler body) |
| Hide from task switchers | **pass** | `WS_EX_TOOLWINDOW` present in the overlay's ex-style (`0x8080008` = layered + topmost + noactivate + toolwindow) |
| Click-through | **pass** | `setIgnoreMouseEvents(true, {forward:true})` applied, `clickThroughUnfocusable=true`; Electron has no read-back API for the mouse flag |
| Global hotkeys while unfocused | **pass** | `Ctrl/Cmd+Shift+Space / A / C / X` registered at startup (`shortcutsRegistered`) |

Measured line:

```
STEALTH_PROBE {"platform":"win32","checks":{"visible":true,"overlayDidNotStealFocus":true,
"meetingKeptFocus":true,"overlayTakesFocusOnClick":true,"passiveAfterFocusRelease":true,
"toolWindowStyle":true,"contentProtectionApiAccepted":true,"contentProtectionReported":null,
"screenCaptureUsable":false,"clickThroughUnfocusable":true},"ok":true,"blurEvents":0,
"exStylesBeforeProtection":134742152,"exStylesAfterProtection":134742152,"affinity":0,
"affinityIsExcludeFromCapture":false,"controlCapture":{"r":0,"g":0,"b":0},
"exclusionEnvironmentLimited":true,"failed":[],"environmentLimited":["screenCaptureUsable"]}
```

**What is still open on Windows.** Capture exclusion is the one row this host
cannot answer: the desktop attached to an SSH session is not composited, so both
`SetWindowDisplayAffinity` and a GDI screen grab are inert. Run
`npm run probe:stealth` from the console session (logged in at the machine, not
over SSH) and expect `screenCaptureUsable=true`, `affinity=17` and
`captureSeesOverlayWithoutProtection=true` /
`captureHidesOverlayWithProtection=true`; those three then become the row.

### Meeting apps (Zoom / Teams / Meet / Webex / OBS)

| App | Windows | macOS | Linux |
|---|---|---|---|
| Zoom | **untested** — not installed on the test box | untested — no host | untested — no OS exclusion API |
| Microsoft Teams | **untested** — not installed | untested — no host | untested |
| Google Meet (browser) | **untested** — not installed | untested — no host | untested |
| Webex | **untested** — not installed | untested — no host | untested |
| OBS | **untested** — not installed | untested — no host | untested |

The Windows mechanism is a per-window OS flag (`WDA_EXCLUDEFROMCAPTURE`), not a
per-app integration: any capture path built on the documented DWM/composition
APIs omits the window, and OBS "Windows 10 (1903+)" capture is the one publicly
documented to honour it. That is why the honest row above is the affinity value,
not a list of app names.

### macOS

No macOS host exists for this project. Every row is **untested**. The code path
is implemented (`type: 'panel'`, `setContentProtection`, `app.dock` untouched by
default) and typechecked on macOS in CI, but it has never been run there.

### Linux

| Concern | Result |
|---|---|
| Per-window capture exclusion | **not available** — GNOME/Mutter has no such flag; documented in the UI |
| Skip taskbar / always-on-top | **pass** on the Zenbook (v0.6 behaviour, unchanged) |
| Non-activating show | `showInactive()` + `setFocusable(false)`; per-compositor behaviour on Wayland is **untested** |
| Click-through | `setIgnoreMouseEvents(true, {forward:true})`; Wayland support is **untested** |
| Global hotkeys while unfocused | best-effort (Wayland often refuses registration; the app logs it) |

### Linux — GNOME stealth bridge (Ubuntu 24.04 / GNOME Shell 46.0, Wayland)

Implemented and measured 2026-11-21 on this host. The extension is installed in
`~/.local/share/gnome-shell/extensions/` and enabled for the next login (GNOME 46
on Wayland cannot hot-load a new extension). `npm run probe:ubuntu-bridge`
passed against a mock `org.osmos.Bridge`; the installer was exercised in a temp
`XDG_DATA_HOME`; the canary harness proved it can both catch and clear a
synthetic leak. `npm run test:ubuntu-bridge-live` then loaded the extension in a
private-bus headless GNOME Shell, opened a real Mutter ScreenCast and captured
its PipeWire stream. That proved the hide path without a desktop interaction;
Chrome/Zoom/OBS, Alt-Tab/Dock and an OCR recording still need §9 on a real
session.

| Concern | Result | Evidence |
|---|---|---|
| Extension syntax | **pass** | `node --check extension.js`, `node --check prefs.js` |
| GSettings schema | **pass** | `glib-compile-schemas --strict` on the schema |
| D-Bus contract (app client) | **pass (mock)** | `probe:ubuntu-bridge`: Ping=`1`, `Mode`, `SharingActive`, `SharingChanged(true/false)`, name loss |
| GJS D-Bus export (extension API) | **pass (mock)** | `gjs -m` mock on a private bus: `wrapJSObject` getters answered, `SharingChanged` and `PropertiesChanged` received by `gdbus monitor` |
| Installer / uninstaller | **pass** | temp `XDG_DATA_HOME`: extension copied, `gschemas.compiled` produced, uninstall removed the tree |
| Canary harness | **pass (synthetic)** | `verify-capture.sh --selftest`: canary video flagged in 4/4 frames, clean control passed |
| Bridge loaded in a real Shell | **pass (headless)** | `test-bridge-live.sh`: headless GNOME Shell 46 loaded the extension; `Ping`=`1`, `Mode` and `SharingActive` answered on D-Bus |
| Hide on share start | **pass (headless Mutter cast)** | Window with WM_CLASS `osmos` absent from the actual PipeWire capture while sharing (0 magenta samples); `SharingActive` observed 115–276 ms after `Session.Start` across headless runs (20 ms polling; signal timing, not first-frame timing) |
| Restore on share end | **pass (headless)** | Switching back to `keep` during the share and a fresh cast after it both captured the window again (67,200 magenta samples) |
| `mode=keep` negative control | **pass (headless)** | Same cast and capture showed the window in `keep` (67,200 samples), so the hiding result is not a broken capture |
| Built-in GNOME recorder | **partial (headless)** | `org.gnome.Shell.Screencast` emitted `SharingChanged(true/false)`; one headless run polled `SharingActive` as false during the recording, so confirm this row on a desktop (T2.1) |
| Two overlapping shares | **untested** | T3.3; the code counts handles, but no overlapping-share run yet |
| Overview / Alt-Tab thumbnail | **best-effort, untested** | While hidden the extension sets `skip_taskbar` (guarded, restored after); real Alt-Tab/Overview behaviour needs a desktop test (T3.5) |
| Canary absent from a real recording | **window path pass (headless), OCR untested** | The magenta-window equivalent of the canary was 67,200 px in `keep` and 0 while hidden; a real meeting-app recording plus the OCR `mode=keep` control still needs T4/T5 on a desktop |
| Share already running when enabled | **known limitation** | Handles that existed before `enable()` are not listed (T7.1) |
| Window vs monitor share | **undistinguished** | The Shell handle carries no source info; both hide |
| Hidden for the user too | **known limitation** | Full-screen share hides the overlay for everyone |
| Dock / top-bar leak | **partially mitigated, untested** | `StartupWMClass=osmos` now ships in the Linux desktop entry; hiding the dock during shares is still separate work (T6) |

Honest UI wording lives in `src/shared/policy/ubuntuBridge.ts` (`bridgeSummary`),
so the app cannot claim a measure this table does not contain.
