# OSMOS

**Open-source, cross-platform AI interview & meeting copilot** for Linux, macOS, and Windows.  

OSMOS listens to your mic or meeting audio, watches screen context via OCR, and suggests answers through a floating always-on-top overlay — without subscription fees or cloud lock-in.

MIT licensed. Built from scratch — not a fork or rebrand of any proprietary interview tool.

---  

## Features (v0.5)

| Area | What you get | 
|---|---|  
| **Overlay** | Frameless, always-on-top assistant with auto-hide, pause/resume, and compact answer cards | 
| **Profiles** | Named profiles (résumé, JD, company, docs, questions, STAR stories) — switch from Home or the overlay menu | 
| **Agents** | Per-profile agent config: custom identity, system prompt, skills, MCP connectors, and optional provider/model override | 
| **Chat** | Streaming LLM replies with cancel; Ollama local or OpenAI / Anthropic / Groq / OpenRouter / LiteLLM | 
| **Web search** | DuckDuckGo by default (no key); optional Tavily or self-hosted SearXNG | 
| **Speech** | Local Whisper (offline), Web Speech, or OpenAI Whisper API | 
| **Smart assist** | Continuous system/meeting audio → STT → auto-suggest (overlap capture while transcribing) | 
| **Screen** | Region capture + Tesseract OCR into chat | 
| **Stealth** | OS capture exclusion on Windows / macOS; Linux share-tab guidance | 
| **Prep** | Company intel, question bank, STAR templates, document RAG | 
| **Sessions** | Local meeting history with transcript timeline and evidence chips | 

---  

## Quick start

```bash
git clone https://github.com/taksha17/osmos.git
cd osmos
npm install
npm run build
npm run pack
```

Linux users: Run `./linux-install.sh`  

macOS users: Open `macos-install.sh`  

Windows users: Open `OSMOS-Setup.exe`  

The installer will automatically:
- Install required Node.js version
- Install system dependencies (ffmpeg, libfuse2, etc.)
- Extract and configure OSMOS

After installation:

1. Complete the onboarding wizard (Ollama URL, mic, profile basics).
2. Open **Start Osmos** for the floating overlay.
3. In Settings → Speech, choose Local Whisper and (optionally) system/meeting audio for Smart assist.
4. Fill Profile → résumé / JD / company URL, then **Assemble interview prep**.

Settings live locally (e.g. `~/.config/OSMOS/osmos-settings.json` on Linux). API keys never leave your machine except when you call cloud providers.

---  

## Requirements

- **Node.js** 20+ (22 recommended)
- **npm** 10+
- Optional but recommended:
   - [Ollama](https://ollama.com) for local models
   - `ffmpeg` (Windows / macOS system audio)
   - PipeWire `pw-record` / `parec` (Linux system audio)
   - [BlackHole](https://existential.audio/blackhole/) (macOS meeting loopback)

### Linux setup advice
Modern Ubuntu often lacks FUSE 2. Prefer:
```bash
npm run pack
npm run start:release
# or
./release/linux-unpacked/osmos
```
Or install the `.deb`, or `sudo apt install libfuse2t64` for AppImages. 

---  

## Commands

| Command | Purpose | 
|---|---|  
| `npm run dev` | Dev: Vite + Electron | 
| `npm run typecheck` | TypeScript checks | 
| `npm run build` | Build renderer + Electron bundles | 
| `npm run pack` | Package for **current OS only** → `release/` | 
| `npm run pack:linux` | AppImage + deb + tar.gz (Linux host) | 
| `npm run pack:mac` | dmg (must run on macOS) | 
| `npm run pack:win` | NSIS installer (must run on Windows) | 
| `npm run start:release` | Run unpacked Linux build without FUSE | 

Do **not** use `npm run pack:all` on one machine — it cannot cross-build mac/win/linux together.

---  

## Architecture

```
src/  
shared/ # types, features registry, modes, brand
main/ # Electron main: windows, IPC, services, platform adapters
preload/ # contextBridge → window.osmos
renderer/ # React UI (launcher + overlay)
scripts/ 
whisper-worker.mjs # system Node Whisper (not Electron renderer)
docs/ 
ROADMAP.md
```  

**Conventions**
- Preload API is `window.osmos`
- System prompts are built only in main via `buildChatContext()`
- OS integration lives under `src/main/platform/`

---  

## Packaging

| Setting area | Options | 
|---|---|  
| **AI provider** | Ollama (default) or cloud providers with API keys | 
| **Web** | Off / DuckDuckGo / Tavily / SearXNG | 
| **Speech** | Local Whisper / Web Speech / OpenAI Whisper; Smart source = system / mic / both | 
| **Loopback device** | Optional BlackHole / WASAPI / PipeWire name (`OSMOS_AUDIO_DEVICE` env override) | 
| **Stealth** | Hide from screen capture where the OS allows | 
| **Profiles** | Multiple named slots with docs, questions, STAR, company intel | 

---  

## Privacy & ethics

- Local-first: Ollama + DuckDuckGo work without accounts.
- Cloud keys (if any) stay in local settings store — never commit them.
- Intended for personal productivity. Use responsibly and in line with interview / workplace policies.

---  

## Roadmap

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) and the in-app Roadmap tab (`src/shared/features.ts`).

Open items include signed/notarized builds and broader real-device validation on Zoom / Teams / Meet.

---  

## Contributing

This repository is maintained by a single owner. Pull requests and collaborator access are not accepted unless the owner opens them. Issues may be opened for bugs and feature ideas; there is no guarantee of response.

For AI coding agents working on a local checkout, read [`AGENTS.md`](./AGENTS.md) first.

---  

## License

[MIT](LICENSE) — Copyright (c) 2026 OSMOS contributors