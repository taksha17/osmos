# AGENTS.md — OSMOS

> **Read this first** before changing code. This file is the shared handoff for any AI coding agent (Cursor, Claude Code, Codex, Copilot, Aider, etc.).

## Product

**OSMOS** is an MIT-licensed, open-source alternative to Cluely: a real-time desktop AI copilot for interviews, meetings, sales calls, and exams. It listens to audio, watches your screen, and suggests answers through a floating overlay—without subscription fees or cloud lock-in.

- Path: `/media/taksha/New Volume/OSMOS` (repo folder; product name is **OSMOS**)
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
| Audio loopback | Platform adapters: Linux `pw-record`/`parec`, Windows PowerShell WASAPI stub, macOS `ffmpeg`/`rec` |
| Settings | `electron-store` → `~/.config/OSMOS/osmos-settings.json` (Linux); migrates from legacy `Unconventionally/` |
| Packaging | electron-builder (AppImage + deb on Linux) |

## Commands

```bash
npm install
npm run dev          # Vite :5179 + Electron (OSMOS_DEV=1)
npm run build        # renderer + electron bundles
npm run typecheck
npm run pack         # package for **current OS only** → release/
npm run pack:linux   # AppImage + deb + tar.gz (Linux host)
npm run pack:mac     # dmg (must run on macOS host)
npm run pack:win     # NSIS installer (must run on Windows host)
```

**Do not run `npm run pack:all` on a single machine.** It tries to build mac+win+linux together and fails on Linux with `Cannot find module 'dmg-license'` (mac dmg tooling). Use `npm run pack` or OS-specific scripts / CI.

Dev entry: `scripts/dev.mjs` → builds electron → Vite → `electron . --no-sandbox`.

**Cross-platform release workflow:**
- Push a `v*` tag to trigger GitHub Actions matrix builds on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
- CI caches electron-builder artifacts, retries on network failure, and uploads all platform installers to the GitHub Release.

## Architecture map

```
src/
  shared/          # types, features registry, modes (imported by main + renderer)
  main/            # Electron main: windows, IPC, Ollama/SearXNG/Whisper/OCR/Providers/History
    platform/      # Linux / macOS / Windows adapters (region capture, audio loopback)
    services/      # ollama, searxng, whisper, localWhisper, ocr, providers, companyIntel, history, updates, retrieval, questionBank
  preload/         # contextBridge → window.osmos
  renderer/        # React UI (App tabs, ChatPanel, ProfilePanel, STT, History, Evidence, QuestionBankTab)
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

## What is live (v0.5.1)

- Launcher + frameless overlay (`#/overlay`) — always-on-top, translucent, draggable
- Streaming LLM chat + cancel (Ollama + cloud providers)
- SearXNG grounding (skipped in **interview** mode unless query looks like research)
- Profile + **named multi-profiles** + modes (interview / meeting / general) → injected into system prompt
- First-run onboarding wizard; overlay quick menu (profile / mode / mic)
- Mic STT: `local-whisper` (Node worker), `webspeech`, `openai-whisper`
- Screen region capture + OCR into chat (Linux: gnome-screenshot/spectacle; macOS: screencapture; Windows: PowerShell full-screen fallback)
- System audio: continuous loopback → STT → Smart assist (Linux `pw-record`/`parec`, Windows `ffmpeg` WASAPI, macOS `ffmpeg`/`rec`); overlay Audio toggles listen; Chat 🔊 is one-shot
- Settings persistence, mic picker, stealth (OS capture exclusion on Win/macOS)
- Global shortcuts: toggle overlay, focus ask, trigger capture
- Company intel: SearXNG research + provider-based synthesis for interview prep
- Document RAG: attach reference files, lightweight TF-IDF retrieval injected into chat context
- Question bank + STAR templates: file-backed interview prep via `question:list/add/delete` and `star:list/add/delete` IPC
- Meeting history: file-backed session persistence + history tab
- Live transcript timeline with auto-scroll
- Answer attribution / evidence chips per assistant message
- Multi-provider LLM settings UI (OpenAI, Anthropic, Groq, OpenRouter, LiteLLM)
- Auto-update checker scaffold (update feed URL input)
- Branding: app icon placeholder, name lock in package metadata
- Linux packaging metadata fixed (`homepage`, author email, deb `maintainer`)
- Cross-platform CI: GitHub Actions matrix builds all three platforms from `v*` tags
- Auto-dependency installers: Linux installer pulls `pipewire`/`pulseaudio-utils` for Smart assist; Windows NSIS installer extracts `ffmpeg` automatically

## Recent fixes (do not regress)

Documented so the next agent does not reintroduce these bugs:

### Packaging (`npm run pack` / `pack:linux` / CI)

- **Symptom A:** `.deb` failed with missing homepage / author email / maintainer.
  - **Fix:** Keep `homepage`, `author.email`, and `build.linux.maintainer` in `package.json`.
- **Symptom B:** `npm run pack:all` fails on Linux with `Cannot find module 'dmg-license'`.
  - **Cause:** That script tried to build mac+win targets from Linux.
  - **Fix:** Use `npm run pack` (current OS) or OS-specific scripts / CI. `pack:all` now exits with a clear error instead of a cryptic module miss.
- **Symptom C:** Packaged `.AppImage` “doesn't run” with `dlopen(): error loading libfuse.so.2`.
  - **Cause:** AppImage runtime needs FUSE 2; Ubuntu often only has fuse3.
  - **Fix:** `npm run start:release` (uses `release/linux-unpacked/`), or install the `.deb`, or `sudo apt install libfuse2t64`.
- Packaged `files` / `asarUnpack` must include `tesseract.js` (and existing Whisper/ORT deps).
- Linux main process always appends `no-sandbox` + ozone auto (packaged and unpackaged).
- **CI packaging failures:** electron-builder on tag push tried to auto-publish releases from packaging jobs and failed with 403 / auth errors.
  - **Fix:** Set `publish: []` in `package.json` `build` config; keep `GH_TOKEN` only in the dedicated `create-release` job; added `--publish never` to `pack:linux`, `pack:mac`, `pack:win` scripts.
- **Windows build flakes:** GitHub-hosted Windows runners intermittently fail downloading Electron release assets.
  - **Fix:** Added `ELECTRON_MIRROR` mirror, per-platform `electron-builder` cache, and `nick-fields/retry` wrapper around packaging jobs in `.github/workflows/ci.yml`.
- **Linux installer missing audio deps:** fresh Ubuntu installs failed system audio because `pw-record`/`parec` were absent.
  - **Fix:** `linux-install.sh` now installs `pipewire` and `pulseaudio-utils`; error messages mention exact `apt` packages.

### Screen OCR

- **Symptom:** Stub `main/services/ocr.ts` returned empty text; running `tesseract.js` in the **renderer** is brittle under Electron.
- **Fix:** Real OCR in `src/main/services/ocr.ts` via `createWorker('eng')`. IPC `ocr:extract`. Renderer `src/renderer/stt/ocr.ts` only forwards to `window.osmos.ocrExtract`. Chat 📷 button: `captureRegion` → `ocrExtract` → paste into composer.
- Capture helpers live on `PlatformAdapter.captureRegion()` in `src/main/platform/index.ts`.

### Ollama empty answers / “only (web: N hits)”

- **Symptom:** SearXNG succeeded, UI showed `(web: 8 hits)` with no body. `gemma4:*` spent ~1–2 min in `thinking` on huge résumé+JD+web prompts before any `content`.
- **Fixes:**
  - Stream parser yields `{ kind: 'thinking' | 'content' }` (`src/main/services/ollama.ts`).
  - UI status: “Model thinking…”.
  - Interview mode skips web search unless the query looks like research.
  - Profile/JD clipped in `buildChatContext`.
  - Empty final answer → explicit `error` event (not a blank bubble + web footer).
  - Probe Ollama saves form URL first, then probes that host (LAN often `http://192.168.4.31:11434`).

### Local Whisper `registerBackend`

- **Symptom:** Transformers.js/ONNX in the renderer crashed (`Cannot read properties of undefined (reading 'registerBackend')`).
- **Fix:** MediaRecorder → WAV in renderer → IPC → `localWhisper.ts` spawns `node scripts/whisper-worker.mjs` (system Node, not Electron).

### Multi-provider chat

- **Symptom:** Chat was hardcoded to Ollama only; cloud providers could not be used.
- **Fix:** Added `ProviderConfig` / `LlmProvider` types, `src/main/services/providers.ts` with `chatWithProvider` and `streamWithProvider`. OpenAI-compatible providers use `/chat/completions`. Settings UI added under Settings tab.

### Document RAG

- **Symptom:** Full document text was pasted into system prompt, quickly hitting context limits for large files.
- **Fix:** Added `src/main/services/retrieval.ts` with lightweight chunk/TF-IDF retrieval. `buildChatContext` now retrieves top-k relevant chunks instead of full-text paste. Renderer `Documents` tab remains the attachment surface.

### Company intel / RAG / history / question bank

- Company intel: web search + provider-based synthesis.
- Document RAG stores `DocumentReference[]` in settings; `buildChatContext` uses lightweight TF-IDF retrieval instead of full-text paste.
- Question bank + STAR templates: file-backed via `question:list/add/delete` and `star:list/add/delete` IPC; injected into interview system prompts; overlay **STAR story** action.
- Meeting history uses file-backed `chat-history.json` via `history:list/save/delete` IPC. ChatPanel auto-saves sessions.

### Overlay polish / audio retry loop / Ubuntu home layout

- **Symptom:** overlay “buffering” / vibration on Ubuntu/Windows when no audio device or missing `ffmpeg`.
  - **Fix:** `ChatPanel.tsx` now guards mic/system auto-start with 5s error backoff so failed capture does not thrash start/stop.
- **Symptom:** Windows installer `ffmpeg` section was a stub and NSIS had compile/runtime issues.
  - **Fix:** Real PowerShell-based ffmpeg extraction in `windows-installer.nsi`; removed duplicate `.onInit`, `Var TEMP` shadowing, invalid `MB_ICONERROR`, and added `WinVer.nsh`.
- **Symptom:** Ubuntu home dashboard layout collapsed / overflowed.
  - **Fix:** Use `minmax(0, ...)` and `auto-fit` for hero/profile/status/mode grids; added responsive breakpoints.
- **Symptom:** Overlay live mic button caused visible vibration.
  - **Fix:** Removed aggressive `pulse` animation from `.mic-btn--live`; stabilized idle transitions.
- **Symptom:** Linux system audio showed generic missing-tool error.
  - **Fix:** `linux-install.sh` installs `pipewire` and `pulseaudio-utils`; `src/main/platform/index.ts` checks `pw-record`/`parec` availability and returns actionable `apt` instructions.

### Stealth / screen-share exclusion

- `platform.applyOsCaptureExclusion` → Electron `setContentProtection` on Windows (`WDA_EXCLUDEFROMCAPTURE`) and macOS (`NSWindowSharingNone`).
- Re-applied on overlay `show` / `focus` (Windows can drop affinity across hide/show).
- Linux: no OS exclusion API — skip taskbar + always-on-top; tell users to share a tab/window, not the full desktop.
- macOS caveat: newer ScreenCaptureKit full-desktop shares may still include the overlay — prefer app/tab share.

## Known gotchas (do not regress)

### Ollama

- Default settings may be `http://127.0.0.1:11434`. This machine’s LAN server is often `http://192.168.4.31:11434` with models `gemma4:e4b`, `qwen2.5:1.5b`.
- **Probe Ollama** must save the form URL first, then call `listOllamaModels(baseUrl)` — never probe only stale disk settings.
- Prefer `qwen2.5:1.5b` when speed matters; `gemma4:e4b` is slower because of thinking.

### STT / Whisper

- **Do not** run `@xenova/transformers` / onnxruntime in the Electron **renderer**.
- Local Whisper path: MediaRecorder → WAV in renderer → IPC → persistent `scripts/whisper-worker.mjs --serve` (or one-shot fallback).
- Web Speech on Linux often fails with `network` (Google cloud). Prefer `local-whisper`.

### Electron / Vite / packaging

- Main/preload are esbuild’d to `dist-electron/`; renderer to `dist/`.
- After changing main/preload, restart `npm run dev` (Vite HMR alone is not enough).
- `GetVSyncParametersIfAvailable` log spam is harmless.
- Do not remove packaging metadata fields required for `.deb` builds.
- If `npm run dev` hangs, check for stuck `npm run dev` / `vite` / `electron` / `tsc` processes and kill them before retrying.

## IPC cheat sheet

| Channel | Purpose |
|---|---|
| `settings:get` / `settings:update` | AppSettings |
| `chat:ask` / `chat:ask-stream` / `chat:cancel-stream` / event `chat:stream` | Chat |
| `ollama:list-models` | Probe models (optional `baseUrl` arg) |
| `searxng:test` | Probe SearXNG |
| `stt:transcribe` | Whisper API or local worker (`engine: 'local' \| 'openai'`) |
| `screen:capture` | Region screenshot → `{ dataUrl, cancelled }` |
| `ocr:extract` | Tesseract OCR on image base64/data URL |
| `system:audio` | Capture system audio → `{ ok, base64?, mimeType?, error? }` |
| `company:intel` | Company research → `{ ok, intel?, error? }` |
| `history:list` / `history:save` / `history:delete` | Meeting history CRUD |
| `question:list` / `question:add` / `question:delete` | Question bank CRUD |
| `star:list` / `star:add` / `star:delete` | STAR template CRUD |
| `app:check-updates` | Update feed check → `UpdateStatus` |
| `overlay:reset-idle` | Reset overlay auto-hide timer |
| `window:toggle-overlay` | Overlay show/hide |

Chat stream events: `meta` | `status` | `delta` | `done` | `error`.

## Profile / modes

- Types: `UserProfile`, `SavedProfile`, `CopilotMode`, `activeMode`, `profile`, `profiles`, `activeProfileId` on `AppSettings`
- Helpers: `src/shared/profiles.ts`
- Mode prompts: `src/shared/modes.ts`
- UI: Profile tab → `ProfilePanel.tsx`; Home Profile hub; overlay `OverlayQuickMenu` (profile / mode / mic)
- First-run: `OnboardingWizard` when `onboardingCompleted` is false (existing installs migrate to true)
- Nested profile merges in `settingsStore.updateSettings` (keeps active slot mirrored)
- Each `SavedProfile` owns: résumé/JD, company name/URL/intel, documents, questions, STAR templates
- PDF/DOCX upload via `file:extract-text` (`documentExtract.ts` + mammoth / pdf-parse)
- `profile:assemble-prep` researches company + seeds question bank from web + JD/résumé
- Documents / Company / Questions tabs operate on the **active** profile only
- Interview prep: question bank + STAR + company intel inject into `buildChatContext`

## Legal / ethics for agents

1. Original code only — no pasting from Natively or other proprietary copilots.
2. User intends to open-source; keep MIT headers and avoid copying licensed assets.
3. Do not commit secrets (API keys). Settings may contain keys in the user’s local electron-store only.
4. Do not print user résumé/JD PII from local settings into commits or public docs.

## Suggested next work (roadmap)

Core Cluely-style loop is largely live. Public GitHub + CI pack artifacts + GitHub Releases for all three platforms are now working. Priority candidates:

1. Signed / notarized builds (EV/OV cert on Windows, Apple Developer ID + notarization on macOS) so installers don't trigger SmartScreen / Gatekeeper.
2. Real-device stealth + BlackHole validation on Windows / macOS with Zoom / Teams / Meet.
3. Faster default model path / tighter overlay answer cards.

See `docs/ROADMAP.md` and `src/shared/features.ts`.

## Validation checklist before declaring done

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] If packaging touched: `npm run pack:linux` (needs homepage + author email + maintainer)
- [ ] To ship installers: push a `v*` tag → triggers CI matrix on ubuntu/macos/windows → releases all platform assets
- [ ] Consider Linux + note macOS/Windows impact for platform-sensitive changes
- [ ] Update `features.ts` / `ROADMAP.md` if capability status changed
- [ ] Restart Electron after main/preload edits

## Session notes (human machine)

- Dev machine: Linux Zenbook; Ollama often on LAN `192.168.4.31:11434`
- SearXNG often at `http://127.0.0.1/searxng` with limiter disabled for private JSON
- User profile may already be populated in local settings — treat as private
- If builds hang, kill stale `npm run dev` / `vite` / `electron` / `tsc` processes before retrying
