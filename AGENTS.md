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
| Audio loopback | Platform adapters: Linux `ffmpeg` pulse / `pw-record` on sink `*.monitor` (not `parec`), Windows `ffmpeg` WASAPI, macOS `ffmpeg`/`rec` + BlackHole |
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
    services/      # ollama, whisper, localWhisper, ocr, imageHash, audioDevices,
                   # linuxLoopbackStream, screenCapture, resolveBin, providers, …
  preload/         # contextBridge → window.osmos
  renderer/
    stt/           # micStt, useMicStt, useSystemAudioStt, useScreenAssist, ocr
    components/    # ChatPanel, HomeDashboard, ProfilePanel, SettingsPanel, …
scripts/
  whisper-worker.mjs   # system Node Whisper (NOT Electron) — required for local STT
docs/
  ROADMAP.md
```

### Linux audio pipeline (Smart listen)

```
pactl → audioDevices.ts + linuxAudioDevices.ts  (resolve *.monitor, prefer laptop speaker)
         ↓
linuxLoopbackStream.ts  (continuous)  OR  captureLinuxMonitorOnce()  (one-shot)
  1. ffmpeg -f pulse -i <monitor>  →  s16le PCM  →  WAV chunks (RMS / silent flag)
  2. pw-record --target=<monitor>  (timed file loop fallback)
         ↓
IPC system:audio-chunk  →  useSystemAudioStt  →  stt:transcribe  →  shouldAutoAssist  →  chat
```

**Never use `parec` for sink monitors on PipeWire** — it often writes 0 bytes while the UI shows “listening”. Mic + one-shot loopback go through `platform/index.ts` → same ffmpeg / pw-record order.

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
| Meeting audio (Linux) | Long-lived `ffmpeg -f pulse` on sink `*.monitor` (`linuxLoopbackStream.ts`) → WAV chunks; remounts on default-sink change | Falls back to timed `pw-record` if ffmpeg unavailable. **Do not use `parec`** — often records 0 bytes on PipeWire |
| Meeting audio (Win/mac) | Chunked `ffmpeg` WASAPI / BlackHole | Same Smart UI |
| Mic STT | Linux: native `ffmpeg` pulse / `pw-record` on preferred input; else MediaRecorder | Device list from `pactl` via `audio:list-devices` |
| Screen OCR | **On-demand** (📷 / Alt+Shift+C); image-hash cache skips identical frames | Never loop `desktopCapturer` on Wayland |
| Assist fusion | `fusedAssistPrompt(transcript + fresh screen OCR)` | Screen text stays “fresh” ~45s after 📷 |

**Why:** On Ubuntu Wayland, Electron `desktopCapturer` opens the xdg-desktop-portal picker. Looping it spam-popups, breaks PipeWire, and fights real meeting shares. Do **not** reintroduce continuous portal capture.

**Natively reference:** Study continuous Pulse monitor + on-demand screen context ideas only — **reimplement original MIT code**. Never paste Natively source (`Personal Use Source License`).

Optional CLI tools for quieter on-demand screenshots: `gnome-screenshot`, `grim`, `spectacle`. Smart listen needs **`ffmpeg`** (pulse input) and/or **`pw-record`** (PipeWire).

### Preload: system-audio API (`window.osmos`)

| Method | Purpose |
|---|---|
| `startSystemAudioListen({ device?, chunkMs? })` | Linux: start `linuxLoopbackStream`; returns `{ ok, mode: 'stream' \| 'fallback', monitor?, backend? }` |
| `stopSystemAudioListen()` | Stop continuous stream |
| `onSystemAudioChunk(cb)` | `{ ok, base64?, mimeType?, silent?, rms?, error? }` — unsubscribe fn returned |
| `onSystemAudioStatus(cb)` | `{ text }` e.g. “Listening via ffmpeg on …” |
| `captureSystemAudio({ durationMs?, device? })` | One-shot loopback (Settings test, fallback on non-Linux) |

Renderer hook: `src/renderer/stt/useSystemAudioStt.ts` — prefers stream on Linux, else chunked `captureSystemAudio`.

## What is live (v0.5.1)

- **Launcher hub** (`launcher-shell`): full-bleed home dashboard — search, Undetectable toggle, Start Osmos, sessions; Profile + Settings open as **modals** (`hub-modal`), not a permanent sidebar
- Frameless overlay (`#/overlay`) — always-on-top, translucent, draggable
- Streaming LLM chat + cancel (Ollama + cloud providers)
- SearXNG / DuckDuckGo / Tavily grounding (skipped in **interview** mode unless query looks like research)
- Profile + **named multi-profiles** + modes (interview / meeting / general) → injected into system prompt
- **Profile Intelligence** modal (left nav: Identity, Resume/JD upload, company intel, docs, question bank)
- First-run onboarding wizard; overlay quick menu (profile / mode / mic)
- Mic STT: `local-whisper` (Node worker), `webspeech`, `openai-whisper`; Linux native mic via ffmpeg / pw-record
- On-demand screen OCR (`captureFullScreen` → Tesseract + image-hash cache); region tools when installed
- System audio: **ffmpeg pulse stream** → STT → Smart assist (Linux); chunked WASAPI / BlackHole elsewhere
- Assist fusion: transcript + optional fresh screen OCR (`fusedAssistPrompt`, ~45s screen freshness in ChatPanel)
- Linux audio device sanitization (`linuxAudioDevices.ts` + `audioDevices.ts`) — prefer laptop mic / speaker monitor
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
- **Linux installer missing audio deps:** `linux-install.sh` installs `pipewire`, `pulseaudio-utils`, and expects **`ffmpeg`** on PATH for loopback.

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
  - **Fix:** Always resolve a real `*.monitor` via `pactl` (`audioDevices.ts` + `linuxAudioDevices.ts`); `tryPwRecordTimed` writes a file and SIGTERM after duration (no `--duration` flag); serialize captures with `withLinuxAudioLock`.
- **Symptom I:** Smart “listening” forever with no transcripts; Settings test returns empty/silent WAV.
  - **Cause:** Continuous path preferred `parec` on sink monitors; on many PipeWire hosts `parec` writes **0 bytes** while `ffmpeg -f pulse` and `pw-record --target=…monitor` work.
  - **Fix:** `linuxLoopbackStream.ts` uses **ffmpeg pulse → stdout PCM** as primary continuous backend, timed **pw-record** as fallback. One-shot `captureSystemAudio` / `captureLinuxMonitorOnce` same order. Never rely on `parec` for monitors.
- Working smoke tests on Zenbook-class machines:
  ```bash
  MONITOR="$(pactl get-default-sink).monitor"
  ffmpeg -nostdin -f pulse -i "$MONITOR" -t 2 -ac 1 -ar 16000 -y /tmp/osmos-test.wav
  # or:
  timeout 2 pw-record --target="$MONITOR" --rate=16000 --channels=1 --format=s16 /tmp/osmos-test.wav
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
- **Linux loopback:** ffmpeg pulse primary, pw-record fallback — **not parec** (see Symptom I).
- Concurrent capture without `withLinuxAudioLock` causes PipeWire errors — serialize mic, one-shot, and stream mount.
- Stream chunks carry `silent: true` when RMS < ~0.006; UI should not spam Whisper on silence.
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
| `system:audio` | One-shot system/loopback capture → WAV base64 |
| `system:listen-start` / `system:listen-stop` | Continuous Linux loopback (`linuxLoopbackStream.ts`) |
| event `system:audio-chunk` / `system:audio-status` | Streamed WAV chunks + status (`silent`, `rms`, `backend`) |
| `audio:list-devices` | Linux pactl inputs/monitors + preferred ids |
| `audio:capture-mic` | Native Linux mic via `ffmpeg` pulse / `pw-record` |
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
- Continuous assist helpers: `src/shared/continuousAssist.ts` (`shouldAutoAssist`, `continuousAssistPrompt`, `fusedAssistPrompt`, `CONTINUOUS_CHUNK_MS`)
- UI: Home hub (`HomeDashboard`); Profile / Settings modals; overlay `ChatPanel` + quick menu
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
4. Lower Smart-listen latency tuning (chunk size, overlap transcribe while capturing).
5. Optional opt-in continuous screen OCR **only** where a non-portal path exists (not Wayland `desktopCapturer` loop).
6. Linux packaged build: bundle or declare `ffmpeg` dependency explicitly in `.deb` / AppImage metadata.

See `docs/ROADMAP.md` and `src/shared/features.ts`.

## Validation checklist before declaring done

- [ ] `npm run typecheck`
- [ ] `npm run build` (or at least `build:electron` after main/preload edits)
- [ ] If packaging touched: `npm run pack:linux` (needs homepage + author email + maintainer)
- [ ] To ship installers: push a `v*` tag → CI matrix → GitHub Release assets
- [ ] Note Linux + macOS/Windows impact for platform-sensitive changes
- [ ] Update `features.ts` / `ROADMAP.md` if capability status changed
- [ ] Restart Electron after main/preload edits
- [ ] On Linux audio changes: smoke-test **ffmpeg pulse** first:
  ```bash
  MONITOR="$(pactl get-default-sink).monitor"
  ffmpeg -nostdin -f pulse -i "$MONITOR" -t 2 -ac 1 -ar 16000 -y /tmp/osmos-test.wav
  ls -la /tmp/osmos-test.wav   # expect tens of KB if speakers active
  ```
  Do **not** use `parec` as the acceptance test on PipeWire.
- [ ] Never leave continuous `desktopCapturer` / portal capture enabled on Wayland

## Session notes (human machine)

- Dev machine: Linux Zenbook (PipeWire / GNOME Wayland); Ollama often on LAN `192.168.4.31:11434`
- Default sink monitor: `alsa_output.pci-…HiFi__hw_sofhdadsp__sink.monitor`; mic often `…_6__source` (laptop digital)
- **Verified:** `ffmpeg -f pulse` + `pw-record --target=…monitor` capture ~64KB/2s; **`parec` records 0 bytes** on this host
- SearXNG often at `http://127.0.0.1/searxng` with limiter disabled for private JSON
- User profile may already be populated in local settings — treat as private
- If builds hang, kill stale `npm run dev` / `vite` / `electron` / `tsc` processes before retrying
- After main/preload audio changes: `npm run build:electron` then restart `npm run dev` (not HMR alone)
