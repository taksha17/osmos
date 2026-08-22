# OSMOS roadmap

Open-source, free alternative to Cluely: real-time desktop AI copilot for interviews, meetings, sales calls, and exams. Listens to audio, watches your screen, and suggests answers through a floating overlay.

## Phase 0 — Foundation (done in v0.1)

- [x] Electron + React + TypeScript monorepo
- [x] Linux / macOS / Windows platform adapter interface
- [x] Launcher + overlay windows
- [x] Settings store
- [x] Ollama chat
- [x] SearXNG grounding
- [x] MIT license + public docs

## Phase 1 — Capture

- [x] Microphone device picker + Web Speech STT
- [x] Optional OpenAI Whisper STT (record → transcribe → ask)
- [x] Auto-ask on final transcript
- [x] Streaming replies in UI (Ollama NDJSON + cancel)
- [x] System audio loopback (PipeWire/Pulse, WASAPI via ffmpeg, CoreAudio) + continuous Smart listen pipeline
- [x] Overlap capture while transcribing + macOS BlackHole / virtual-device auto-pick
- [x] Screenshot / region capture + OCR
- [x] Global shortcuts with graceful Wayland fallback (in-app tip when OS registration fails)

## Phase 2 — Grounding

- [x] Resume / JD ingest and local profile store
- [x] Named multi-profiles (Cluely-style Customize) + Home Profile hub + overlay switcher
- [x] Company intel from web search + LLM synthesis
- [x] Modes / personas with source policies (interview / meeting / general)
- [x] Document RAG for attached reference files
- [x] Multi-backend web search (DuckDuckGo default, Tavily optional, SearXNG advanced)
- [x] First-run setup wizard

## Phase 3 — Meeting OS

- [x] Live transcript timeline
- [x] Meeting history dashboard
- [x] Answer attribution / evidence panels
- [x] Continuous meeting assistant mode (listen → suggest → overlay)
- [x] Overlay polish for live interviews (auto-hide on inactivity, compact answer cards)
- [x] Company question bank + STAR answer templates (prompt injection + overlay STAR action)

## Phase 4 — Providers & polish

- [x] OpenAI / Anthropic / Groq / OpenRouter / LiteLLM
- [x] Streaming tokens in UI
- [x] Auto-update channel
- [x] Stealth / screen-share safer overlay (Win/macOS OS capture exclusion, skip taskbar, faster idle dim; Linux share-tab guidance)
- [ ] Signed builds + notarization (CI matrix builds unsigned artifacts today)
- [x] Branding pass (name lock, icon, landing)
- [x] CI typecheck + build matrix (unsigned packaging on Linux)

## Design rules

1. No copied proprietary source.
2. Platform differences live behind adapters.
3. Features ship behind the registry until `live`.
4. Prefer local-first (Ollama + DuckDuckGo) with optional cloud keys.
