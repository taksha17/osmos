# Regression guards

Condensed from `AGENTS.md` → "Recent fixes (do not regress)". Each row is a bug
that shipped once; the guard column says what stops it coming back. Keep this
list short and link the phase that replaces a rule rather than deleting it.

| # | Symptom | Root cause | Guard |
|---|---|---|---|
| A | `.deb` build failed (missing homepage / author email / maintainer) | packaging metadata removed | fields kept in `package.json` |
| B | `pack:all` fails on Linux (`dmg-license`) | cross-building mac from Linux | `pack:all` exits with the OS-specific instructions |
| C | AppImage will not run (`libfuse.so.2`) | AppImage FUSE requirement | `npm run start:release`, `.deb`, or `libfuse2t64` |
| D | Unpacked Linux binary dies in GTK (`xsettings`) | Wayland + bad `XDG_DATA_DIRS` | `scripts/start-release.mjs` forces X11 ozone |
| E | Whisper spawn `ENOTDIR` | `app.asar` used as spawn cwd | `resolveBin.ts` `safeSpawnCwd()` + asarUnpack |
| F | Region capture always cancelled | no screenshot CLI installed | `captureFullScreen()` CLI→`desktopCapturer` chain |
| F2 | Endless portal dialogs during Smart mode | continuous `desktopCapturer` loop | Smart = audio only; screen OCR is on demand |
| F3 | CLI tools crash under VS Code Snap shell | poisoned `LD_LIBRARY_PATH`/GIO vars | `cleanSpawnEnv()` before every spawn |
| G | Ctrl+Enter Assist dead, Alt+Shift+A/C inert | Enter handled first; preload never exposed `onShortcut` | handler order + `window.osmos.onShortcut` |
| H | `pw-record` records the mic, not the sink | missing `--target` monitor | always resolve `*.monitor` via `pactl` |
| I | Smart "listening" forever, 0-byte WAV | `parec` on PipeWire monitors | ffmpeg pulse primary, `pw-record` fallback, never `parec` |
| J | Windows "needs ffmpeg/WASAPI" | mainline ffmpeg has no WASAPI demuxer | Chromium loopback (`electronLoopback.ts`) |
| K | Screen reader captures once then stops | one-shot path / LLM on every frame | persistent poll loop + frame hash; answers only on hotkey |
| L | `screen:capture-full` SIGSEGVs Electron | Snap env leaked into tesseract worker | `cleanSpawnEnv()` on the CLI-tool spawn path |
| M | Screen reading fed the overlay's own answers back | `setOpacity` is a no-op on Linux | no fade; `stripOverlayEcho()` in the renderer |
| N | "No permissions or prompts — just keep reading" | portal picker + `gnome-screenshot` flash | Mutter ScreenCast worker (`screen_worker.py`) preferred on GNOME |

## v2 migration guards (Phase 0)

| Guard | Why |
|---|---|
| `src/shared/policy/screenSnapshot.ts` | the only screen classifier; `looksLikeCodeScreen` derives from `classifySnapshot`, and the screen-section instruction comes from `HINTS` — two code heuristics drifting apart is how a code screenshot ends up on the fast lane |
| `src/shared/policy/*` parity tests | `planLanes` still matches the v0.6 `routeDecision` at the default thresholds; `decideTrigger` deliberately deviates (§7.3: notes and self-speech never answer) and `triggerPolicy.test.ts` records the diff, justified by the labelled eval in `bench/fixtures/triggers/` |
| `bench/` replay harness | routing, prompt and trigger changes need a measured before/after |
| Contracts import no Electron | each contract must run in a worker and in plain Node |
