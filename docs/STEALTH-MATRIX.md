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
| Capture exclusion | **not available** — no OS API; documented in the UI ("share a tab/window") |
| Skip taskbar / always-on-top | **pass** on the Zenbook (v0.6 behaviour, unchanged) |
| Non-activating show | `showInactive()` + `setFocusable(false)`; per-compositor behaviour on Wayland is **untested** |
| Click-through | `setIgnoreMouseEvents(true, {forward:true})`; Wayland support is **untested** |
| Global hotkeys while unfocused | best-effort (Wayland often refuses registration; the app logs it) |
