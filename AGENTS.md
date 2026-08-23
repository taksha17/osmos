# AGENTS.md — OSMOS

> **Read this first** before changing code. This file is the shared handoff for any AI coding agent (Cursor, Claude Code, Codex, Copilot, Aider, etc.).

## Product

**OSMOS** is an MIT-licensed, open-source alternative to Cluely: a real-time desktop AI copilot for interviews, meetings, sales calls, and exams. It listens to audio, can OCR the screen on demand, and suggests answers through a floating overlay—without subscription fees or cloud lock-in.

- Path: `/media/taksha/New Volume/OSMOS` (repo folder; product name is **OSMOS**)
- GitHub: `https://github.com/taksha17/osmos` (public)
- **Not** a fork or rebrand of Natively. Natively at `/media/taksha/New Volume/natively` is **personal reference only** — study ideas, never copy proprietary/source-available code.
- License: MIT (`LICENSE`)
- Current version: **0.5.1** (`package.json`)
- Reference product: Cluely (real-time interview/meeting copilot). We match core UX: desktop overlay, live transcription, screen context, answer suggestions. We do **not** copy proprietary code or data.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 34 |
| UI | React 19 + Vite 6 + TypeScript |
| Local LLM | Ollama HTTP (`/api/chat` NDJSON stream) |
| Cloud LLMs | OpenAI / Anthropic / Groq / OpenRouter / LiteLLM via OpenAI-compatible `/chat/completions` |
| Web search | DuckDuckGo (default) / Tavily / SearXNG |
| Offline STT | System Node worker + `@xenova/transformers` Whisper tiny |
| Screen OCR | Main-process `tesseract.js` via `ocr:extract` IPC |
| Audio loopback | Platform adapters: Linux `pw-record`/`parec` (sink `*.monitor`), Windows `ffmpeg` WASAPI, macOS `ffmpeg`/`rec` + BlackHole |
| Settings | `electron-store` → `~/.config/OSMOS/osmos-settings.json` (Linux); migrates from legacy `Unconventionally/` |
| Packaging | electron-builder (AppImage + deb on Linux) |

## Commands

```bash
npm install
npm run dev              # Vite :5179 + Electron (OSMOS_DEV=1)
npm run build            # renderer + electron bundles
npm run build:electron   # main/preload only (fast after main/preload edits)
npm run typecheck
npm run pack             # package for **current OS only** → release/
npm run pack:linux       # AppImage + deb + tar.gz (Linux host)
npm run pack:mac         # dmg (must run on macOS host)
npm run pack:win         # NSIS installer (must run on Windows host)
npm run start:release    # run unpacked Linux build (see Symptom D)
```

**Do not run `npm run pack:all` on a single machine.** It tries to build mac+win+linux together and fails on Linux with `Cannot find module 'dmg-license'` (mac dmg tooling). Use `npm run pack` or OS-specific scripts / CI.

Dev entry: `scripts/dev.mjs` → builds electron → Vite → `electron . --no-sandbox`.

**Cross-platform release workflow:**
- Push a `v*` tag to trigger GitHub Actions matrix builds on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
- CI caches electron-builder artifacts, retries on network failure, and uploads all platform installers to the GitHub Release.

## Architecture map

```
src/
  shared/          # types, features, modes, continuousAssist, linuxAudioDevices
  main/
    platform/      # Linux / macOS / Windows adapters (capture, audio loopback, stealth)
    services/      # ollama, whisper, localWhisper, ocr, audioDevices, screenCapture,
                   # resolveBin, providers, retrieval, history, …
  preload/         # contextBridge → window.osmos
  renderer/
    stt/           # micStt, useMicStt, useSystemAudioStt, ocr (no Transformers.js)
    components/    # ChatPanel (Smart overlay), Settings, Profile, …
scripts/
  whisper-worker.mjs   # system Node Whisper (NOT Electron) — required for local STT
docs/
  ROADMAP.md
```

### Critical conventions

1. **Preload API is `window.osmos`** (not `electronAPI` / legacy `window.uncon`).
2. **Settings type is `AppSettings`**; store key is `settings`; file name `osmos-settings`.
3. System prompt is built **only in main** via `buildChatContext()` in `src/main/index.ts`. Renderer sends `{ message, history }` only.
4. Feature status lives in `src/shared/features.ts` (`live` | `scaffold` | `planned`). Keep `docs/ROADMAP.md` in sync.
5. Cross-platform: never ship Unix-only or Windows-only commands in shared scripts; prefer Node APIs. Platform OS integration goes behind `src/main/platform/`.
6. Prefer `@shared/...` imports in renderer; main uses relative `../shared/...` with `.js` extensions in compiled ESM.
7. Heavy native/WASM work (Whisper, Tesseract) stays in **main or a system Node worker** — not the Electron renderer.
8. Provider abstraction: chat routes through `chatWithProvider` / `streamWithProvider` in `src/main/services/providers.ts`, not direct Ollama calls.
9. After **main/preload** changes: `npm run build:electron` and restart `npm run dev` (Vite HMR is not enough).

## Smart assist model (do not confuse with Cluely screen-share)

**Smart / Continuous mode listens to meeting audio — it does not steal the user’s Zoom/Meet screen share.**

| Capability | Mechanism | Notes |
|---|---|---|
| Meeting audio | PipeWire/Pulse **sink monitor** (`default-sink.monitor`) via `pw-record` / `parec` | Independent of screen-share portal |
| Mic STT | Linux: native `pw-record` on preferred input; else MediaRecorder | Device list from `pactl` via `audio:list-devices` |
| Screen OCR | **On-demand only** (📷 / Alt+Shift+C / `screen:capture-full`) | Never loop `desktopCapturer` on Wayland |
| Assist trigger | Transcript finals → `shouldAutoAssist` → LLM | Ctrl+Enter / Assist button also works |

**Why:** On Ubuntu Wayland, Electron `desktopCapturer` opens the xdg-desktop-portal picker. Looping it every few seconds spam-popups, breaks PipeWire (`thread-loop` errors), and fights real meeting shares. Do **not** reintroduce continuous portal capture.

Optional CLI tools for quieter on-demand screenshots: `gnome-screenshot`, `grim`, `spectacle`.

## What is live (v0.5.1)

- Launcher + frameless overlay (`#/overlay`) — always-on-top, translucent, draggable
- Streaming LLM chat + cancel (Ollama + cloud providers)
- SearXNG / DuckDuckGo / Tavily grounding (skipped in **interview** mode unless query looks like research)
- Profile + **named multi-profiles** + modes (interview / meeting / general) → injected into system prompt
- First-run onboarding wizard; overlay quick menu (profile / mode / mic)
- Mic STT: `local-whisper` (Node worker), `webspeech`, `openai-whisper`
- On-demand screen OCR (`captureFullScreen` → Tesseract); region tools when installed
- System audio: continuous loopback → STT → Smart assist (Linux monitor, Windows WASAPI, macOS BlackHole/`ffmpeg`)
- Linux audio device sanitization (`src/shared/linuxAudioDevices.ts` + `audioDevices.ts`) — prefer laptop mic / speaker monitor
- Settings persistence, mic + loopback pickers, stealth (OS capture exclusion on Win/macOS)
- Shortcuts: Ctrl/Cmd+Enter Assist; Alt+Shift+Space overlay; Alt+Shift+A ask; Alt+Shift+C capture (Wayland globals often fail — in-app still works)
- Company intel, document RAG, question bank + STAR, meeting history
- Live transcript timeline; evidence chips; multi-provider settings; update-feed scaffold
- Cross-platform CI from `v*` tags; Linux installer pulls PipeWire deps; Windows NSIS extracts `ffmpeg`

## Recent fixes (do not regress)

Documented so the next agent does not reintroduce these bugs:

### Packaging (`npm run pack` / `pack:linux` / CI)

- **Symptom A:** `.deb` failed with missing homepage / author email / maintainer.
  - **Fix:** Keep `homepage`, `author.email`, and `build.linux.maintainer` in `package.json`.
- **Symptom B:** `npm run pack:all` fails on Linux with `Cannot find module 'dmg-license'`.
  - **Cause:** That script tried to build mac+win targets from Linux.
  - **Fix:** Use `npm run pack` (current OS) or OS-specific scripts / CI. `pack:all` now exits with a clear error.
- **Symptom C:** Packaged `.AppImage` “doesn't run” with `dlopen(): error loading libfuse.so.2`.
  - **Fix:** `npm run start:release` (uses `release/linux-unpacked/`), or install the `.deb`, or `sudo apt install libfuse2t64`.
- **Symptom D:** Unpacked Linux binary / `start:release` dies with
  `GLib-GIO-ERROR … xsettings … antialiasing`.
  - **Cause:** Electron/GTK under Wayland + bad `XDG_DATA_DIRS`.
  - **Fix:** `scripts/start-release.mjs` forces `GDK_BACKEND=x11`, cleans schema dirs, `--ozone-platform=x11`. Packaged main also forces X11 ozone.
- **Symptom E:** Overlay audio / Local Whisper fails with `spawn ENOTDIR` (Ubuntu packaged) or vague ffmpeg/spawn errors.
  - **Cause:** Packaged Whisper used `app.getAppPath()` (`…/app.asar`, a *file*) as `spawn` cwd; bare tools on a dirty PATH can also ENOTDIR.
  - **Fix:** Run Whisper from `app.asar.unpacked` with a real directory cwd (`resolveBin.ts` / `safeSpawnCwd`); asarUnpack `scripts/whisper-worker.mjs` + `@xenova/transformers`; absolute paths for capture tools (incl. bundled `ffmpeg.exe` on Windows).
- Packaged `files` / `asarUnpack` must include `tesseract.js` (and existing Whisper/ORT deps).
- Linux main process always appends `no-sandbox` + ozone auto (packaged and unpackaged).
- **CI packaging:** `publish: []` in electron-builder; `--publish never` on pack scripts; `GH_TOKEN` only in `create-release` job.
- **Windows build flakes:** `ELECTRON_MIRROR`, electron-builder cache, retry wrapper in `.github/workflows/ci.yml`.
- **Linux installer missing audio deps:** `linux-install.sh` installs `pipewire` + `pulseaudio-utils`.

### Screen OCR + Wayland portal

- **Symptom:** Stub OCR / renderer Tesseract brittle under Electron.
  - **Fix:** Main-process `src/main/services/ocr.ts`; IPC `ocr:extract`; renderer only forwards.
- **Symptom F:** No `gnome-screenshot`/`spectacle` on many Ubuntu installs → region capture always cancelled.
  - **Fix:** `captureFullScreen()` via `src/main/services/screenCapture.ts` — try CLI (`gnome-screenshot -f`, `spectacle -f`, `grim`, `scrot`) then Electron `desktopCapturer` last.
- **Symptom F2 (critical):** Continuous Smart screen OCR looped `desktopCapturer` → endless portal dialogs, PipeWire `thread-loop` errors, fights Zoom/Meet share.
  - **Fix:** Smart = **audio only**. Screen OCR = **on-demand** (📷 / hotkey). Never reintroduce a continuous portal capture loop.

### Shortcuts

- **Symptom G:** Ctrl+Enter Assist dead (plain Enter handled first); Alt+Shift+A/C sent `shortcut` but preload never exposed it.
  - **Fix:** Check Ctrl/Cmd+Enter **before** Enter; `window.osmos.onShortcut`; overlay capture-phase keydown; register `CommandOrControl+Enter` when OS allows. Wayland often cannot register globals — in-app still works.

### Linux system audio (PipeWire)

- **Symptom H:** `pw-record` without `--target` records the default *mic*, not the sink monitor; many builds reject `--duration`.
  - **Fix:** Always resolve a real `*.monitor` via `pactl` (`audioDevices.ts` + `linuxAudioDevices.ts`); `tryPwRecordTimed` writes a file and SIGTERM after duration (no `--duration` flag); serialize captures with `withLinuxAudioLock`; soft-retry in `useSystemAudioStt`.
- Working smoke test on Zenbook-class machines:
  ```bash
  timeout 2 pw-record --target="$(pactl get-default-sink).monitor" \
    --rate=16000 --channels=1 --format=s16 /tmp/osmos-test.wav
  ```
- Device heuristics live in `src/shared/linuxAudioDevices.ts` (inspired by personal Natively logic — **reimplemented**, not copied wholesale). Prefer laptop digital mic (`DEV=6` / `_6__source`) and speaker sink monitor over HDMI.

### Ollama empty answers / “only (web: N hits)”

- Stream parser yields `{ kind: 'thinking' | 'content' }`; UI “Model thinking…”.
- Interview mode skips web search unless the query looks like research.
- Profile/JD clipped in `buildChatContext`; empty final → explicit `error` event.
- Probe Ollama saves form URL first, then probes that host (LAN often `http://192.168.4.31:11434`).

### Local Whisper `registerBackend`

- **Do not** run `@xenova/transformers` / onnxruntime in the Electron **renderer**.
- Path: MediaRecorder or native WAV → IPC → `localWhisper.ts` → `scripts/whisper-worker.mjs` (system Node).

### Multi-provider / RAG / history / question bank

- `providers.ts` + Settings UI for cloud LLMs.
- Document RAG: TF-IDF retrieval in `retrieval.ts` (not full-text paste).
- Question bank + STAR + company intel + file-backed history — see IPC table.

### Overlay polish

- Mic/system auto-start: 5s error backoff (no thrash).
- Home dashboard: `minmax(0, …)` / `auto-fit` grids.
- Windows NSIS: real ffmpeg extract; no duplicate `.onInit` / invalid `MB_ICONERROR`.

### Stealth / screen-share exclusion

- Win/macOS: `setContentProtection`; re-apply on overlay show/focus.
- Linux: no OS exclusion API — skip taskbar + always-on-top; share a **tab/window**, not full desktop.
- macOS: prefer app/tab share (ScreenCaptureKit full-desktop may still include overlay).

## Known gotchas (do not regress)

### Ollama

- Default may be `http://127.0.0.1:11434`. Dev LAN often `http://192.168.4.31:11434` (`gemma4:e4b`, `qwen2.5:1.5b`).
- Prefer `qwen2.5:1.5b` when speed matters; `gemma4:e4b` is slower (thinking).

### STT / Whisper / audio

- Local Whisper = system Node worker only.
- Web Speech on Linux often fails with `network` — prefer `local-whisper`.
- Concurrent `pw-record` without the audio lock causes PipeWire errors — keep `withLinuxAudioLock`.
- Harmless Chromium log: `GetVSyncParametersIfAvailable` failed.

### Electron / Vite / packaging

- Main/preload → `dist-electron/`; renderer → `dist/`.
- After main/preload edits: rebuild electron + restart Electron.
- Do not remove `.deb` packaging metadata fields.
- If `npm run dev` hangs, kill stuck `npm run dev` / `vite` / `electron` / `tsc` before retrying.
- Incomplete `release/linux-unpacked` (interrupted pack) cannot `start:release` — repack or use `npm run dev`.

## IPC cheat sheet

| Channel | Purpose |
|---|---|
| `settings:get` / `settings:update` | AppSettings |
| `chat:ask` / `chat:ask-stream` / `chat:cancel-stream` / event `chat:stream` | Chat |
| `ollama:list-models` | Probe models (optional `baseUrl`) |
| `searxng:test` / `websearch:test` | Probe search |
| `stt:transcribe` | Whisper API or local worker (`engine: 'local' \| 'openai'`) |
| `screen:capture` | Interactive region (when tools exist) → `{ dataUrl, cancelled }` |
| `screen:capture-full` | Silent fullscreen for OCR (CLI first, portal last) |
| `ocr:extract` | Tesseract OCR |
| `system:audio` | System/loopback capture → WAV base64 |
| `audio:list-devices` | Linux pactl inputs/monitors + preferred ids |
| `audio:capture-mic` | Native Linux mic via `pw-record`/`parec` |
| `company:intel` | Company research |
| `history:*` / `question:*` / `star:*` | CRUD |
| `app:check-updates` | Update feed |
| `overlay:reset-idle` / `window:toggle-overlay` | Overlay |
| event `shortcut` | `'ask'` \| `'capture'` → preload `onShortcut` |
| event `overlay` | idle, etc. → `onOverlayEvent` |
| event `settings:changed` | Live settings push |

Chat stream events: `meta` | `status` | `delta` | `done` | `error`.

## Profile / modes

- Types: `UserProfile`, `SavedProfile`, `CopilotMode`, `activeMode`, `profile`, `profiles`, `activeProfileId` on `AppSettings`
- Helpers: `src/shared/profiles.ts`; mode prompts: `src/shared/modes.ts`
- Continuous assist helpers: `src/shared/continuousAssist.ts` (`shouldAutoAssist`, `continuousAssistPrompt`, `continuousScreenPrompt`)
- UI: Profile tab; Home hub; overlay `OverlayQuickMenu`
- First-run: `OnboardingWizard` when `onboardingCompleted` is false
- Each `SavedProfile` owns résumé/JD, company intel, documents, questions, STAR templates
- PDF/DOCX via `file:extract-text`; `profile:assemble-prep` seeds prep from web + JD/résumé

## Legal / ethics for agents

1. Original code only — no pasting from Natively or other proprietary copilots.
2. User intends to open-source; keep MIT headers and avoid copying licensed assets.
3. Do not commit secrets (API keys). Settings may contain keys in the user’s local electron-store only.
4. Do not print user résumé/JD PII from local settings into commits or public docs.

## Suggested next work (roadmap)

1. Signed / notarized builds (Windows EV/OV, macOS Developer ID + notarization).
2. Real-device stealth + BlackHole validation on Windows / macOS with Zoom / Teams / Meet.
3. Faster default model path / tighter overlay answer cards.
4. Optional long-lived PipeWire stream (vs chunked spawn/kill) for lower Smart-listen latency.
5. Optional opt-in continuous screen OCR **only** where a non-portal path exists (not Wayland `desktopCapturer` loop).

See `docs/ROADMAP.md` and `src/shared/features.ts`.

## Validation checklist before declaring done

- [ ] `npm run typecheck`
- [ ] `npm run build` (or at least `build:electron` after main/preload edits)
- [ ] If packaging touched: `npm run pack:linux` (needs homepage + author email + maintainer)
- [ ] To ship installers: push a `v*` tag → CI matrix → GitHub Release assets
- [ ] Note Linux + macOS/Windows impact for platform-sensitive changes
- [ ] Update `features.ts` / `ROADMAP.md` if capability status changed
- [ ] Restart Electron after main/preload edits
- [ ] On Linux audio changes: smoke-test `pw-record --target="$(pactl get-default-sink).monitor" …`
- [ ] Never leave continuous `desktopCapturer` / portal capture enabled on Wayland

## Session notes (human machine)

- Dev machine: Linux Zenbook (PipeWire / GNOME Wayland); Ollama often on LAN `192.168.4.31:11434`
- Default mic often `…_6__source` (laptop digital); default monitor `…sofhdadsp__sink.monitor`
- SearXNG often at `http://127.0.0.1/searxng` with limiter disabled for private JSON
- User profile may already be populated in local settings — treat as private
- If builds hang, kill stale `npm run dev` / `vite` / `electron` / `tsc` processes before retrying
