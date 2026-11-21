# AGENTS.md — OSMOS

> **Read this first** before changing code. This file is the shared handoff for any AI coding agent (Cursor, Claude Code, Codex, Copilot, Aider, etc.).

## Product

**OSMOS** is an MIT-licensed, open-source alternative to Cluely: a real-time desktop AI copilot for interviews, meetings, sales calls, and exams. It listens to audio, can OCR the screen on demand, and suggests answers through a floating overlay—without subscription fees or cloud lock-in.

- Path: `/media/taksha/New Volume/OSMOS` (repo folder; product name is **OSMOS**)
- GitHub: `https://github.com/taksha17/osmos` (public)
- **Not** a fork or rebrand of Natively. Natively at `/media/taksha/New Volume/natively` is **personal reference only** — study ideas, never copy proprietary/source-available code.
- License: MIT (`LICENSE`)
- Current version: **0.6.0** (`package.json`)
- Reference product: Cluely (real-time interview/meeting copilot). We match core UX: desktop overlay, live transcription, screen context, answer suggestions. We do **not** copy proprietary code or data.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 34 |
| UI | React 19 + Vite 6 + TypeScript |
| Local LLM | Ollama HTTP (`/api/chat` NDJSON stream) |
| Cloud LLMs | OpenAI / Anthropic / Groq / OpenRouter / LiteLLM via OpenAI-compatible `/chat/completions` |
| Web search | DuckDuckGo (default) / Tavily / SearXNG |
| Offline STT | System Node worker + `@huggingface/transformers` v4 — **Moonshine tiny (default, MIT)** or Whisper base.en |
| Screen OCR | Main-process `tesseract.js` via `ocr:extract` IPC. Continuous 👁 Live prefers a **silent main backend** on every OS: **Mutter ScreenCast** (GNOME), **GDI/PowerShell** (Windows), **`screencapture -x`** (macOS), CLI (`spectacle`/`grim`/`scrot`) elsewhere. Renderer `getDisplayMedia` is Windows/macOS fallback only — **never** on Linux |
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
npm test                 # pure shared unit tests (router + question bank)
npm run pack             # package for **current OS only** → release/
npm run pack:linux       # AppImage + deb + tar.gz (Linux host)
npm run pack:mac         # dmg (must run on macOS host)
npm run pack:win         # NSIS installer (must run on Windows host)
npm run start:release    # run unpacked Linux build (see Symptom D)
```

**Do not run `npm run pack:all` on a single machine.** It tries to build mac+win+linux together and fails on Linux with `Cannot find module 'dmg-license'` (mac dmg tooling). Use `npm run pack` or OS-specific scripts / CI.

Dev entry: `scripts/dev.mjs` → builds electron → Vite → `electron . --no-sandbox`.

**Cross-platform release workflow (offline — no GitHub Actions pack matrix):**
- On each OS host: `npm run pack:linux` / `pack:mac` / `pack:win` (downloads ffmpeg + bundled LLM once).
- Upload installers: `npm run release:upload` (uses `gh release create/upload`).
- CI only runs typecheck on Ubuntu to save Action minutes.

## Architecture map

```
src/
  shared/          # types, features, modes, continuousAssist, screenContext, linuxAudioDevices
  main/
    platform/      # Linux / macOS / Windows adapters (capture, audio loopback, stealth)
    services/      # ollama, whisper, localWhisper, ocr, imageHash, audioDevices,
                   # linuxLoopbackStream, screenCapture, screenLive,
                   # mutterScreenCast (GNOME no-prompt screen read), resolveBin, providers, …
  preload/         # contextBridge → window.osmos
  renderer/
    stt/           # useMainMicStt, useSystemAudioStt, liveScreenStream, ocr
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
3. System prompt is built **only in main** via `buildChatContext()` in `src/main/index.ts`. Renderer sends `{ message, history, screenText?, screenAt? }` — raw context, never prompt text.
4. Feature status lives in `src/shared/features.ts` (`live` | `scaffold` | `planned`). Keep `docs/ROADMAP.md` in sync.
5. Cross-platform: never ship Unix-only or Windows-only commands in shared scripts; prefer Node APIs. Platform OS integration goes behind `src/main/platform/`.
6. Prefer `@shared/...` imports in renderer; main uses relative `../shared/...` with `.js` extensions in compiled ESM.
7. Heavy native/WASM work (Whisper, Tesseract) stays in **main or a system Node worker** — not the Electron renderer.
8. Provider abstraction: chat routes through `chatWithProvider` / `streamWithProvider` in `src/main/services/providers.ts`, not direct Ollama calls. Hybrid routing (`src/shared/lumenRoute.ts` + `hybridChat.ts`) may pick a fast Ollama lane or draft-then-upgrade before the quality provider — still via that same abstraction.
9. After **main/preload** changes: `npm run build:electron` and restart `npm run dev` (Vite HMR is not enough).
10. **Never rely on bare `ffmpeg` in packaged builds.** Always resolve through `getFfmpegPath()` / `resolveFfmpeg()` (bundled `resources/bin` first, then known installs, then PATH). See `FIXES.md` Symptom J.
11. **Never await LLM inference inline inside a capture loop.** Fire-and-handle; keep capture running independently.
12. **Always hash/diff frames before OCR+LLM** in continuous screen assist (pixel diff in `liveScreenStream.ts`, not byte-sampling of JPEG).
14. **Never loop a flashing screenshot tool** (`gnome-screenshot`, xdg Screenshot portal). Continuous reading: GNOME = Mutter ScreenCast; Windows = GDI; macOS = `screencapture -x`. **Do not** fall back to `getDisplayMedia` on Linux. Portal is Windows/macOS last resort only.
15. **Never call `setOpacity` on Linux expecting it to work** — it is a no-op there. Strip overlay self-echo from OCR in the renderer instead.
13. **Ship third-party license notices** (`THIRD-PARTY-NOTICES.md`) when bundling GPL/LGPL binaries such as ffmpeg.

## v2 migration (`docs/ARCHITECTURE-V2.md`)

The v1.0 restructuring is specified in `docs/ARCHITECTURE-V2.md`. It ships in seven phases; each keeps v0.6 behaviour as the fallback until its exit criteria are measured in `docs/BENCHMARKS.md`. Phase 0 (foundations) is in: contracts, an event vocabulary, a delegating trigger/router policy with parity tests, the `bench/` replay harness, and a 3-OS typecheck + test CI matrix.

**Where new code goes:**

| Concern | Path |
|---|---|
| Event vocabulary + replay log | `src/shared/events.ts` |
| Provider interfaces (types only) | `src/shared/contracts/*` |
| Trigger policy, router v2, context budget | `src/shared/policy/*` (pure, unit-tested) |
| Prompt assets | `src/shared/prompts/*` (Phase 3) |
| LLM / OCR / STT adapters | `src/main/providers/{llm,ocr,stt}/*` |
| Benchmarks + fixtures | `bench/` → `npm run bench` |

**Rules:**

1. **Do not add logic to `src/main/index.ts`** (~1.3k lines). Put behaviour in a service or policy module and call it from the handler; splitting that file is Phase 1–3 work.
2. Contracts are types only — never import `electron` from `src/shared/contracts/*`, so `bench/` can drive them from plain Node.
3. Platform behaviour stays behind `src/main/platform/index.ts`. New code must degrade cleanly on Linux, macOS and Windows — CI runs typecheck + tests on all three.
4. Routing, prompt or trigger changes need a `npm run bench` before/after in the PR description.
5. `src/shared/policy/triggerPolicy.ts` and `routerV2.ts` currently delegate to the v0.6 heuristics. Their parity tests must keep passing until the replacement lands with a benchmark.
6. Packaging stays on each OS host (`pack:linux` / `pack:mac` / `pack:win`). CI has no pack jobs.

### Workers (Phase 1)

Capture and STT run in **supervised external processes**, never inline in main.

- Supervisor: `src/main/supervisor/workerSupervisor.ts` (spawn, JSON-lines channel, stderr tail, stall watchdog, restart-with-backoff). Decisions live in `src/shared/policy/workerRuntime.ts` and are unit-tested.
- Capture worker: `src/workers/capture/capture-worker.mjs`. **Main resolves the backend** (`pactl` / `dshow` / AVFoundation) and passes ffmpeg args; the worker owns the pipe, chunk slicing, overlap tail and RMS gate.
- Client: `src/main/services/captureWorkerClient.ts` keeps the old `chunk` / `status` / `error` surface, so `src/main/index.ts` and the renderer did not change.
- Worker scripts must appear in **both** `build.files` and `build.asarUnpack` (`src/workers/**/*`), like `scripts/whisper-worker.mjs`.
- **Unpack everything a worker can `require`.** `build.asarUnpack` carries `node_modules/**/*`. Workers run under plain Node from `app.asar.unpacked`, and Node never looks inside `app.asar`, so a per-package unpack list silently drops transitive modules — that is how packaged Whisper lost `detect-libc`/`@img/colour` (`Cannot find module` on a clean Windows install, 2026-11-20).
- Runtime: bundled Electron (`ELECTRON_RUN_AS_NODE=1`) first, system Node second. Never add a new dependency on `node` being on PATH.
- Kill switches: `OSMOS_CAPTURE_WORKERS=0` (inline streams), `OSMOS_WORKER_RUNTIME=system`, `OSMOS_NODE_BINARY=<path>`.
- A worker must never import `electron`; it has to run under plain Node too, which is what makes the bench and smoke tests possible.
- Workers are **bundled** (`scripts/build-workers.mjs` → `dist-electron/workers/*.mjs`) so they can import tested shared policy. `build:electron` rebuilds both. Point `workerPaths.ts` at the bundle, and keep `dist-electron/workers/**` in `asarUnpack`.

### Endpointing (Phase 2)

- `src/shared/policy/vadEndpoint.ts` owns the utterance state machine (§5.2). One implementation, used by the capture worker — never re-implement silence detection in a hook or a component.
- The worker emits `{type:'utterance'}` with the pre-roll included; main forwards it as `mic:utterance` / `system:audio-utterance` (preload: `onMicUtterance` / `onSystemAudioUtterance`).
- Fixed-size `chunk` messages still ship for the current hooks. When you move a hook to utterances, delete its chunk path rather than running both.
- Silero VAD replaces only the per-frame voice test; keep `EndpointDetector` as the timing layer.

### Orchestrator, trigger policy and lanes (Phase 3)

- `src/shared/policy/triggerPolicy.ts` is the only place that decides *whether* to answer (§7.3). Only a direct question or a hotkey fires; meeting cues return `notes: true` and must never produce a model request; a repeat inside the 10 s window is `duplicate`; the user's own channel never fires. Do **not** reintroduce "answer anything long" — that v0.6 heuristic is what Phase 3 replaced. Agreement/tag questions (`Wasn't that demo great?`, short, no wh-word) are deliberately not asks, and imperative stems (`name`, `list`, `show me`, …) count as asks even without a `?`.
- `src/shared/policy/orchestrator.ts` owns the request lifecycle (§7.4) as a pure state machine: speculative start on a partial with confidence ≥ 0.8, `keep` when the final is within 20 % edit distance, `restart` when it is not, cancel when a newer question arrives, cancel at the 15 s deadline. It **returns actions** and never spawns or cancels a request itself — keep the provider calls in the caller.
- Lane choice is `src/shared/policy/routerV2.ts`: hard rules (code snapshot → vision lane; no vision model → OCR text), a `easyMaxWords` threshold input (default `EASY_MAX_WORDS`), and a fallback chain ending at the quality lane after the 2.5 s first-token budget. `decision` stays the v0.6 result so status lines and parity tests keep working.
- `src/shared/policy/contextBudget.ts` builds the §7.2 `ContextPacket` and is the only place section budgets are applied; trimming is by relevance (recency + question overlap, retrieval score), never arbitrary slicing.
- Trigger quality is re-measured by `npm run bench` from `bench/fixtures/triggers/labelled.jsonl`. When a trigger rule changes, add a labelled case for it rather than editing an existing label.

### Web access (v3, `docs/ARCHITECTURE-V3.md`)

W0 is in: `src/shared/contracts/web.ts`, the pure capability router in `src/shared/policy/webAccess.ts`, the T0 adapter in `src/main/providers/web/builtin.ts`, and the Web Access Manager registry in `src/main/services/webAccess.ts`. Chat still calls `searchWeb()`, so nothing has changed yet.

1. **All fetching goes through the WAM** (`src/main/services/webAccess.ts`) — never call a scraper or search API from the renderer, and never add a second HTTP path beside it.
2. **Respect locality.** `local-only` must return "not available locally" instead of falling through to a cloud tier.
3. **Web content is untrusted data, never instructions.** Delimit it in the prompt, never give it tool authority, never auto-follow links found in a page (Architecture v3 §9.3).
4. **URL Guard before any provider call** (§9.1) once the Firecrawl adapter lands (W1); loopback/private/metadata ranges stay blocked.
5. **AGPL separation:** OSMOS is MIT. Firecrawl runs as a separate user-controlled process over HTTP — do not vendor, link or copy its code, and keep it listed in `THIRD-PARTY-NOTICES.md`.

## Smart assist model (do not confuse with Cluely screen-share)

**Smart / Continuous mode listens to meeting audio — it does not steal the user’s Zoom/Meet screen share.**

| Capability | Mechanism | Notes |
|---|---|---|
| Meeting audio (Linux) | Long-lived `ffmpeg -f pulse` on sink `*.monitor` (`linuxLoopbackStream.ts`) → WAV chunks; remounts on default-sink change | Falls back to timed `pw-record` if ffmpeg unavailable. **Do not use `parec`** — often records 0 bytes on PipeWire |
| Meeting audio (Win/mac) | Chunked `ffmpeg` WASAPI / BlackHole | Windows packages **bundle** `ffmpeg.exe` via `extraResources` (`scripts/ensure-ffmpeg-win.mjs`) |
| Mic STT | Linux: native `ffmpeg` pulse / `pw-record` on preferred input; else MediaRecorder | Device list from `pactl` via `audio:list-devices` |
| Screen OCR | 📷 + 👁 Live via `screenLive.ts` / `screen:grab`. Same silent order on every OS: (1) Mutter ScreenCast, (2) Win GDI / mac `screencapture -x` / KDE `spectacle` / `grim` / `scrot` | **gnome-screenshot flashes → never looped.** `getDisplayMedia` is Win/mac fallback only. Never loop `desktopCapturer` on Wayland |
| Screen → answers | Renderer sends `ChatRequest.screenText/screenAt` (fresh ≤45s); main `buildChatContext()` injects an “On-screen text (OCR)” block | Renderer first runs `prepareScreenContext()` (`shared/screenContext.ts`) to drop UI noise **and the overlay’s own answers** (Linux has no capture exclusion) |
| Assist fusion | `fusedAssistPrompt(transcript)` for auto-ask; screen comes via the request field above | Do not paste OCR into the user message any more — it is system-prompt context |

**Why:** On Ubuntu Wayland, Electron `desktopCapturer` opens the xdg-desktop-portal picker. Looping it spam-popups, breaks PipeWire, and fights real meeting shares. Do **not** reintroduce continuous portal capture.

**Natively reference:** Study continuous Pulse monitor + on-demand screen context ideas only — **reimplement original MIT code**. Never paste Natively source (`Personal Use Source License`).

Optional CLI tools for quieter screenshots: `gnome-screenshot`, `grim`, `spectacle`. Smart listen needs **`ffmpeg`** (pulse input) and/or **`pw-record`** (PipeWire). Windows Smart audio uses **Electron display-media loopback** (not ffmpeg WASAPI).

**Capture strategy reference:** [`docs/CAPTURE-STRATEGY.md`](./docs/CAPTURE-STRATEGY.md) and `src/shared/captureStrategy.ts` (`getCaptureStrategy()`).

### Preload: system-audio API (`window.osmos`)

| Method | Purpose |
|---|---|
| `startSystemAudioListen({ device?, chunkMs? })` | Linux: start `linuxLoopbackStream`; returns `{ ok, mode: 'stream' \| 'fallback', monitor?, backend? }` |
| `stopSystemAudioListen()` | Stop continuous stream |
| `onSystemAudioChunk(cb)` | `{ ok, base64?, mimeType?, silent?, rms?, error? }` — unsubscribe fn returned |
| `onSystemAudioStatus(cb)` | `{ text }` e.g. “Listening via ffmpeg on …” |
| `captureSystemAudio({ durationMs?, device? })` | One-shot loopback (Settings test, fallback on non-Linux) |

Renderer hook: `src/renderer/stt/useSystemAudioStt.ts` — prefers stream on Linux, else chunked `captureSystemAudio`.

## What is live (v0.6.0)

- **Launcher hub** (`launcher-shell`): full-bleed home dashboard — search, Low-profile toggle, Start Osmos, sessions; Profile + Settings open as **modals** (`hub-modal`), not a permanent sidebar
- Frameless overlay (`#/overlay`) — always-on-top, translucent, draggable
- Streaming LLM chat + cancel (Ollama + cloud providers)
- Hybrid routing: bundled Qwen2.5-1.5B fast lane, question-bank/easy-question grounding, draft-then-upgrade, provider warmup
- SearXNG / DuckDuckGo / Tavily grounding (skipped in **interview** mode unless query looks like research)
- Profile + **named multi-profiles** + modes (interview / meeting / general) → injected into system prompt
- **Profile Intelligence** modal (left nav: Identity, Resume/JD upload, company intel, docs, question bank)
- First-run onboarding wizard; overlay quick menu (profile / mode / mic)
- Mic STT: `local-whisper` (Node worker), `webspeech`, `openai-whisper`; Linux native mic via ffmpeg / pw-record
- Screen reading: 📷 one-shot + 👁 Live via the silent main engine on every OS (Mutter / Win GDI / macOS `screencapture`). Self-echo stripped; fresh text auto-attached via `ChatRequest.screenText`. Overlay **Live** pane shows speech; ask bar is type-only.
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
  - **Fix:** Run Whisper from `app.asar.unpacked` with a real directory cwd (`resolveBin.ts` / `safeSpawnCwd`); asarUnpack `scripts/whisper-worker.mjs` + `@huggingface/transformers` + `onnxruntime-*`; absolute paths for capture tools (incl. bundled `ffmpeg.exe` on Windows).
- **Symptom F:** Packaged Windows app transcribes nothing; the whisper worker exits with
  `Cannot find module 'detect-libc'` (or another transitive package) while the same
  source tree works in dev.
  - **Cause:** `whisper-worker.mjs` runs under plain Node in `app.asar.unpacked`. Its
    resolution walks the unpacked tree only, so anything left inside `app.asar` —
    including `sharp`'s deps and other transitive packages — is invisible.
  - **Fix:** `build.asarUnpack` unpacks `node_modules/**/*` rather than a package
    whitelist. Verify with the installed-tree probe (below), not just the config.
- Packaged `files` / `asarUnpack` must include `tesseract.js` (and existing Whisper/ORT deps).
- Linux main process always appends `no-sandbox` + ozone auto (packaged and unpackaged).
- **Verify a build from the artefact, not the config.** Build, install it, then run the installed binary with `ELECTRON_RUN_AS_NODE=1` against a probe that resolves the worker, captures audio and transcribes with `node`/`python`/`ffmpeg` removed from `PATH`. On Windows start the packaged exe with `Start-Process -Wait`: it is a GUI-subsystem binary, so `&` returns immediately and `$LASTEXITCODE` stays stale (a passing-looking check that never ran).
- **CI packaging:** disabled — pack locally and `npm run release:upload`. CI is typecheck-only.
- **Windows build flakes:** `ELECTRON_MIRROR`, electron-builder cache, retry wrapper in `.github/workflows/ci.yml`.
- **Linux installer missing audio deps:** `linux-install.sh` installs `pipewire`, `pulseaudio-utils`, and expects **`ffmpeg`** on PATH for loopback.

### Screen OCR + Wayland portal

- **Symptom:** Stub OCR / renderer Tesseract brittle under Electron.
  - **Fix:** Main-process `src/main/services/ocr.ts`; IPC `ocr:extract`; renderer only forwards.
- **Symptom F:** No `gnome-screenshot`/`spectacle` on many Ubuntu installs → region capture always cancelled.
  - **Fix:** `captureFullScreen()` via `src/main/services/screenCapture.ts` — try CLI (`gnome-screenshot -f`, `spectacle -f`, `grim`, `scrot`) then Electron `desktopCapturer` last.
- **Symptom F2 (critical):** Continuous Smart screen OCR looped `desktopCapturer` → endless portal dialogs, PipeWire `thread-loop` errors, fights Zoom/Meet share.
  - **Fix:** Smart = **audio only**. Screen OCR = **on-demand** (📷 / hotkey). Never reintroduce a continuous portal capture loop.
- **Symptom F3 (dev-only):** CLI screenshot tools crash with `undefined symbol: __libc_pthread_init` inside VS Code Snap shell; child spawns inherit poisoned `LD_LIBRARY_PATH`/`GIO_MODULE_DIR`/`GDK_PIXBUF_*`/`GSETTINGS_SCHEMA_DIR`.
  - **Fix:** `cleanSpawnEnv()` in `screenCapture.ts` strips Snap/bootstrap vars before spawning CLI tools; also `gnome-screenshot` exit-0 does **not** mean the PNG exists — poll the tmp file up to 1.5 s after close before reading it.
- **Symptom L (`screen:capture-full` crashing Electron):** gnome-screenshot succeeds (exit 0, PNG written) yet the OCR step SIGSEGVs Electron on Wayland when run under VS Code Snap env. Root cause: Snap's `LD_LIBRARY_PATH`/`GIO_MODULE_DIR` leak into tesseract worker spawn.
  - **Fix:** The CLI-tool spawn path now uses `cleanSpawnEnv()` for any `spawn()`/`execFile()` of system tools; the image-to-buffer → Tesseract flow no longer touches `LD_LIBRARY_PATH`-dependent paths directly from Electron.
- **Symptom M (screen reading “doesn’t work”, 2026-09-05) — three root causes, all fixed; do not regress:**
  1. `BrowserWindow.setOpacity()` is a **documented no-op on Linux**. `screenLive.ts` used it to “hide” the overlay before each shot → every frame OCR’d OSMOS’s own answer and fed it back to the model. Fix: no fade; renderer strips self-echo with `stripOverlayEcho()` (`shared/screenContext.ts`) using the texts it is currently displaying (last messages, transcript, composer, button labels; tolerant of OCR typos via ≥70–80% token overlap).
  2. **`gnome-screenshot` flashes the screen on every call** on GNOME Wayland (hard-coded in Shell, no flag), and `grim`/`scrot` do not work on Mutter. The old “loop-safe” gate approved it → 2.5 s strobe. Fix: `describeLoopSafeCapture()` excludes gnome-screenshot (one-shot 📷 only); on GNOME Wayland the CLI loop refuses with a clear reason.
  3. Screen text was only used when `autoAskOnFinal` was on. Ctrl+Enter / “What should I say?” sent the bare question. Fix: `sendMessage` attaches `screenText/screenAt`; main injects it into the system prompt.
- **Symptom N (user: “no permissions or prompts — just keep reading the screen”, 2026-09-05) — SOLVED for GNOME Linux:** The portal (`getDisplayMedia`) shows a picker and `gnome-screenshot` flashes; neither is silent+dialog-free. **Fix:** call `org.gnome.Mutter.ScreenCast` directly — the compositor API the portal wraps. `src/python/screen_worker.py` creates a session, `RecordMonitor` on the primary connector, `Start`, gets the PipeWire node, and runs `pipewiresrc ! videoconvert ! videoscale ! video/x-raw,format=I420,width=1440 ! jpegenc ! appsink` (I420 → correct colours; RGB tints green). It emits base64 JPEG frames on stdout (byte-equal frames skipped). `src/main/services/mutterScreenCast.ts` spawns it (via `cleanSpawnEnv()` so Snap's `LD_LIBRARY_PATH` doesn't break GStreamer), OCRs each frame with backpressure, and emits `text`. `screenLive.start()` probes Mutter first (`screen_worker.py probe`: gi/GStreamer import + live Mutter D-Bus name + `pipewiresrc` plugin) and prefers it; the renderer on Linux calls the main engine **before** the portal so there is no dialog and no flash. Needs system `python3-gi` + GStreamer + `gstreamer1.0-pipewire` (default on Ubuntu GNOME); nothing is bundled, so it's only offered when the probe passes. GNOME-only (X11 GNOME works too; non-GNOME falls back to the portal/CLI). **Do not** reintroduce a portal-first path on GNOME Linux.
- **Streaming live-screen (`src/renderer/stt/liveScreenStream.ts`) is the Windows/macOS fallback only.** Silent main backends go first: Mutter (GNOME), GDI (Windows), `screencapture -x` (macOS). `getDisplayMedia` is auto-granted on Win/mac via `setDisplayMediaRequestHandler` and already excludes the content-protected overlay. Never start it on Linux. 📷 uses `screen:grab` (same silent backends) on every OS.
- On Linux the display-media handler requests `types: ['screen','window']` (unless audio loopback is active) so the portal shows both tabs.
- OCR timing on the Zenbook (2880×1800): gnome-screenshot ≈2.4 s, Tesseract ≈3.7 s full-res, ≈2 s at 2000 px wide.
- **Never** pipe CLI screenshots through a GIF ffmpeg chain on Linux; always read PNG → base64 directly.

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

### Windows ffmpeg + continuous screen

- **Symptom J:** Windows “system audio needs ffmpeg / WASAPI…” at overlay / Smart start.
  - **Cause:** Mainline ffmpeg **has no WASAPI demuxer**; older OSMOS code assumed `-f wasapi -i loopback`.
  - **Fix:** Windows Smart listen uses **Chromium desktop loopback** (`electronLoopback.ts` + `desktop:list-sources`). ffmpeg bundling remains optional for other tools.
- **Symptom J2:** Windows mic capture fails with ffmpeg's “Could not find audio only device”
  even though the machine clearly has audio.
  - **Cause:** `listDshowAudioInputs()` falls back to `Win32_SoundDevice` when ffmpeg
    cannot enumerate dshow audio. Those are sound *cards* (“Realtek High Definition
    Audio”), not DirectShow input labels, so the fallback returns names ffmpeg rejects.
  - **Fix:** The fallback enumerates **audio endpoints**
    (`Get-PnpDevice -Class AudioEndpoint -PresentOnly`, `Status -eq 'OK'`) — the labels
    dshow actually accepts — so a machine with no attached endpoint reaches the honest
    “No DirectShow microphones found” path instead of a late ffmpeg error.
    A box with only inactive endpoints (NVIDIA Broadcast / TV) is an environment gap,
    not a code bug.
- **Symptom K:** Screen reader captures once then stops / auto-answers continuously.
  - **Cause:** One-shot path or continuous OCR fired LLM on every frame change.
  - **Fix:** Persistent poll loop + frame hash for context; **answers only on Ctrl/Cmd+Enter / Assist / hotkeys** (overlay never auto-sends).

### Ollama empty answers / “only (web: N hits)”

- Stream parser yields `{ kind: 'thinking' | 'content' }`; UI “Model thinking…”.
- Interview mode skips web search unless the query looks like research.
- Profile/JD clipped in `buildChatContext`; empty final → explicit `error` event.
- Probe Ollama saves form URL first, then probes that host (LAN often `http://192.168.4.31:11434`).

### Local STT (moonshine / whisper worker)

- **Do not** run `@huggingface/transformers` / onnxruntime in the Electron **renderer**.
- Path: MediaRecorder or native WAV → IPC `stt:transcribe` → `localWhisper.ts` → `scripts/whisper-worker.mjs` (system Node, `--serve` warm model).
- **Default model: `onnx-community/moonshine-tiny-ONNX`** (MIT, fast CPU streaming STT). Alternative: `Xenova/whisper-base.en`. Selectable via `AppSettings.localSttModel` (Settings → Local STT model) and `TranscribeRequest.model`.
- **Moonshine gotchas (do not regress):**
  - Requires `@huggingface/transformers` **v3/v4**, not v2 `@xenova/transformers`.
  - fp32 ONNX export **silently transcribes empty** — worker pins `dtype: 'q8'` for moonshine. fp16 fails to init on CPU; q4 also yields empty. Use q8.
  - `moonshine-base-ONNX` currently returns empty on CPU in every tested dtype — do not ship as default until verified; tiny is fine.
  - Whisper `.en` variants reject `language`/`task` args — worker skips them for `.en` models.
- Packaged builds must asarUnpack `@huggingface/transformers` + `onnxruntime-*` (worker runs in system Node, cannot read asar).

### Multi-provider / RAG / history / question bank

- `providers.ts` + Settings UI for cloud LLMs.
- **Hybrid routing (Lumen-inspired, MIT reimplementation):** `lumenRoute.ts` tiers (`fast` / `balanced` / `quality`). Fast lane prefers **bundled** Qwen2.5-1.5B via `llama-server` (`resources/llm/`, `ensure-bundled-llm.mjs`) on **Linux, macOS, and Windows** (x64/arm64); optional Lumen gateway or Ollama tag fallback. Quality = `activeProvider`. `draftThenUpgrade` streams a quick draft then replaces with the quality answer. Overlay open / Assist warms the quality provider (`provider:warmup`). Do **not** vendor Lumen-Stream-Lab into the installer; do **not** commit GGUF weights to git. Pack each OS on that OS host so the matching `llama-server` runtime is embedded (`pack:linux` / `pack:mac` / `pack:win`).
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

### Smart-listen mic stream — PARKED (2026-08-24, Linux)

> **Moved in v2 Phase 1:** continuous mic capture now runs in the supervised capture worker, which logs ffmpeg close codes + stderr tail to `~/.config/OSMOS/logs/mic-stream.log` and restarts with backoff. The history below is kept because the original wedge is still the acceptance test (30-minute soak, see `docs/ARCHITECTURE-V2.md` §17 Phase 1).

State when paused: **first transcription works, then capture pipe dies**. Verified working stages (do not re-litigate):
- dmic `_6__source` hears room audio (rms 2254 measured); loopback monitors healthy
- whisper-worker argv bug FIXED (was reading node ELF); base.en cached; serve mode OK
- Mic capture now lives in MAIN process (`src/main/services/micStream.ts`) — renderer churn can't kill it
- Self-healing layers shipped: respawn-on-close (5×), 0.25s chunk overlap, renderer stall watchdog (15s)

Remaining symptom: pipe still starves after ~1st chunk on this Zenbook/PipeWire host. Next leads when resumed:
1. Log `MicStream` close codes + stderr tail (errBuf already captured) to see WHY ffmpeg exits
2. Test `pw-record --target=<source>` streaming fallback (pw-record file-loop pattern exists in linuxLoopbackStream)
3. Check PipeWire source suspend/adaptive-latency conflicts when BOTH monitor-stream + mic-stream run concurrently
4. Renderer hook `useMainMicStt.ts` + IPC `mic:listen-start/stop`, preload `startMicListen` — all wired

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
| `chat:ask` / `chat:ask-stream` / `chat:cancel-stream` / event `chat:stream` | Chat; `ChatRequest` may carry `screenText` + `screenAt` (fresh OCR → system prompt). Stream may emit `phase: draft|upgrade` + `route` meta for hybrid routing |
| `provider:warmup` / `provider:warmup-status` / `lumen:probe-gateway` | Wake quality (+ fast) provider; probe optional Lumen HTTP gateway |
| `ollama:list-models` | Probe models (optional `baseUrl`) |
| `searxng:test` / `websearch:test` | Probe search |
| `stt:transcribe` | Whisper API or local worker (`engine: 'local' \| 'openai'`) |
| `screen:capture` | Interactive region (when tools exist) → `{ dataUrl, cancelled }` |
| `screen:capture-full` | Fullscreen for OCR; `{ loopSafe: true }` = silent tools only (no gnome-screenshot, no portal) |
| `screen:can-loop` | Whether a **silent** non-portal loop tool exists (`describeLoopSafeCapture`) |
| `screen:live-start` / `screen:live-stop` / `screen:live-capable` / event `screen:live-text` | Main live engine (`screenLive.ts` → Mutter on GNOME). Event: `{ text, at, error? }` |
| `screen:grab` | Silent one-shot OCR (Mutter on GNOME — no picker, no flash) |
| `ocr:extract` | Tesseract OCR (main) — used by 📷, 👁 Live frames, and the CLI loop |
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

## Agentic branch (`Agentic`)

- Work in the `Agentic` branch for profile-as-agent work.
- New shared types: `AgentConfig`, `AgentSkill`, `AgentMcp` in `src/shared/types.ts`
- Agent resolver: `src/shared/agents.ts` (`resolveAgent`, `effectiveProvider`)
- Chat wiring: `src/main/index.ts` `buildChatContext()` injects agent block and honors provider/model override
- MCP client stub: `src/main/services/agentMcp.ts`; start with GitHub search, then expand
- Profile UI: `src/renderer/components/ProfilePanel.tsx` has an **Agent** section for skills/MCP/provider override
- Keep changes scoped to the agent layer; do not disturb global chat routing unless necessary

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
- **Windows test box:** `192.168.1.4`, user `Taksh` (`TAKSHA-DESKTOP`, Win 11 Home, Node 24, git 2.54). OpenSSH is up but password auth is required — `Taksh` is an administrator, so keys must go in `C:\ProgramData\ssh\administrators_authorized_keys`, not the user's home. Run PowerShell over SSH with `-EncodedCommand` (base64 UTF-16LE) to avoid quoting issues; use bare `git`, not `git.cmd`. Keep one clone at `C:\Users\taksh\osmos-ci` for PR checks.
- Default sink monitor: `alsa_output.pci-…HiFi__hw_sofhdadsp__sink.monitor`; mic often `…_6__source` (laptop digital)
- **Bundled-runtime spike (reproducible):**
  `env -i HOME=$HOME PATH=/tmp/osmos-empty-bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u) ELECTRON_RUN_AS_NODE=1 SPIKE_MONITOR="$(pactl get-default-sink).monitor" ./node_modules/electron/dist/electron .qwen/spike-nopath.mjs`
  where `/tmp/osmos-empty-bin` holds `node`/`ffmpeg` shims that exit 127 if anything
  actually looks them up on PATH. Keep `XDG_RUNTIME_DIR` — without it ffmpeg cannot
  reach PipeWire and the failure looks like a runtime bug. 30-minute soak:
  `SOAK_SECONDS=1800 node .qwen/soak-capture.mjs` (logs progress every 60 s).
- **Windows test box Electron:** `node_modules/electron/dist` shipped without a binary;
  `npm` and the npmmirror registry endpoint both hang there, but
  `https://cdn.npmmirror.com/binaries/electron/<version>/electron-v<version>-win32-x64.zip`
  answers. Download it, `Expand-Archive`, copy into `node_modules/electron/dist` —
  `electron.exe --version` prints nothing (GUI subsystem), so check it with
  `ELECTRON_RUN_AS_NODE=1 electron.exe -e "console.log(process.versions.node)"` instead.
  Sending files over: inline base64 hits the Windows command-line limit; pipe the file
  into `powershell -EncodedCommand` over ssh stdin and read it with
  `[Console]::In.ReadToEnd()`.
- **Verified:** `ffmpeg -f pulse` + `pw-record --target=…monitor` capture ~64KB/2s; **`parec` records 0 bytes** on this host
- SearXNG often at `http://127.0.0.1/searxng` with limiter disabled for private JSON
- User profile may already be populated in local settings — treat as private
- If builds hang, kill stale `npm run dev` / `vite` / `electron` / `tsc` processes before retrying
- After main/preload audio changes: `npm run build:electron` then restart `npm run dev` (not HMR alone)
- Audio troubleshooting log (2026-08-24):
  - Linux device discovery initially used the wrong `pactl` short-list ordering; fixed by trying `pactl list short sources|sinks` first, then the legacy order.
  - Added a warning path so Settings shows when only fallback/placeholder audio devices are available.
  - Windows system audio first used `setDisplayMediaRequestHandler(... audio: 'loopback')` but the renderer loopback stream was being torn down too early; fixed by keeping the stream alive until stop.
  - Windows `MediaRecorder` start failed until the recorder was switched to an audio-only `MediaStream` built from the loopback audio tracks.
  - Windows `getDisplayMedia` was asking for audio with a newer constraints object; normalized it back to plain `audio: true` so Electron's loopback handler can actually supply the track.
  - Windows pack initially failed because `scripts/ensure-ffmpeg-win.mjs` referenced an undefined `force`; fixed that helper.
  - Windows pack also needed a bundled Python path and workspace-local `node-gyp` cache to get past native rebuilds.
  - Fresh Windows installer was produced at `release/OSMOS Setup 0.5.2.exe`, but the user still reports no audio after install, so runtime Windows audio capture still needs follow-up.
  - Added `src/shared/audioCaptureProfile.ts` as a single original audio-strategy file: platform-specific system/mic backend order, 16 kHz mono runtime profile, and human-readable warnings for the settings UI.
