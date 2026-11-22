# OSMOS roadmap

Where the project actually stands, what is next, and what is blocked on hardware or certificates rather than on code.
Every claim here is backed by `docs/ARCHITECTURE-V2.md` (specification + phase exit criteria) and `docs/BENCHMARKS.md` (measurements).

**Version:** 0.6.4 · **Tests:** 301 passing on Windows / Linux / macOS CI · **Licence:** MIT

---

## v0.6 — the v1 product (shipped)

- [x] Electron + React + TypeScript app, frameless always-on-top overlay, launcher hub
- [x] Streaming chat: Ollama first-class, OpenAI / Anthropic / Groq / OpenRouter / LiteLLM behind one OpenAI-compatible surface
- [x] Mic + speaker capture: ffmpeg pulse / pw-record (Linux), Chromium loopback (Windows), AVFoundation + BlackHole (macOS)
- [x] Local STT worker (Whisper base.en default, Moonshine tiny optional) — no Python, no audible prompts
- [x] Screen OCR in the main process (Tesseract) through silent per-OS backends
- [x] Profiles, named multi-profiles, modes, company intel, document RAG, question bank + STAR
- [x] Hybrid routing: bundled Qwen2.5-1.5B fast lane, draft-then-upgrade, provider warmup
- [x] Meeting history, transcript timeline, settings persistence

## v2 — the architecture rewrite (shipped, phases 0–7)

Each phase has its exit criteria and its measured result in `docs/ARCHITECTURE-V2.md`.

- [x] **Phase 0 — Foundations.** Event vocabulary, provider contracts (types only), delegating trigger/router policy with parity tests, `bench/` replay harness, 3-OS typecheck + test CI.
- [x] **Phase 1 — Workers.** Capture and STT in supervised external processes with a stall watchdog and restart backoff; measured 30-minute soak, ≈3 % CPU / ≈93 MB idle.
- [x] **Phase 2 — Endpointing.** Utterance state machine in `shared/policy/vadEndpoint.ts`; end-of-speech p50 **460 ms**, transcript p50 **510 ms**, WER **6.5 %**.
- [x] **Phase 3 — Orchestrator and lanes.** Trigger policy (precision/recall **1.000**), speculative start → keep/restart/cancel, first token p50 **49 ms** / p95 **348 ms** on the bundled 1.5B.
- [x] **Phase 4 — Screen.** One classifier (`classifySnapshot`), gated fixtures (**1.0** accuracy, **1.0** code recall), vision payload path, rolling snapshot history.
- [x] **Phase 5 — Memory and reports.** SQLite via `sql.js`, hybrid ranking with reported components, offline session reports with a *History → Export report* path.
- [x] **Phase 6 — Stealth.** Presentation policy in `stealthWindow.ts`, `overlay:focus` / click-through, `npm run probe:stealth`, published matrix.
- [x] **Phase 7 — Distribution.** Full (~1.2 GB) and lite (~284 MB) installers, first-run SHA-256-verified weight download, tag-only pack matrix on three OSes.
- [x] macOS runtime fixes: ad-hoc signing of vendored Mach-O helpers (Apple Silicon refuses unsigned), Screen Recording denial surfaced instead of a black image, system audio refuses to record the microphone when no virtual cable exists, overlay above fullscreen Spaces.

## v3 — self-hosted web access (scaffold)

- [x] W0: capability contracts (`shared/contracts/web.ts`), pure capability router (`shared/policy/webAccess.ts`), T0 builtin adapter, Web Access Manager registry
- [ ] W1: Firecrawl adapter behind the URL guard (loopback/private/metadata ranges blocked), wired into chat
- [ ] Web content treated as untrusted data end to end, with citations
- [ ] Chat routed through the WAM instead of `searchWeb()`

## Next

- [ ] Model pack **size and progress** in Settings (the first-run download is console-logged today)
- [ ] Delta updates for the model pack; resumable across restarts is already done
- [ ] Lite installer install test on a clean VM per OS
- [ ] Cloud-lane latency and vision recall measurements (needs provider keys)
- [ ] Optional Silero VAD as the per-frame voice test, keeping `EndpointDetector` as the timing layer

## Blocked on hardware, certificates or third parties

- [ ] **Signed / notarized installers.** No Apple Developer ID, no Windows OV/EV certificate. Every artefact is unsigned; macOS needs a one-line quarantine clear and Windows shows SmartScreen. This is the one v2 exit criterion the repository cannot satisfy by itself.
- [ ] **Vision on two cloud providers plus one local model.** Only the wire path is proven — no keys, no local vision model on the test machines.
- [ ] **macOS clean-machine install + real-device stealth matrix.** Needs a Mac with a screen someone can click on: Screen Recording / Microphone / Accessibility grants, BlackHole, and Zoom/Teams/Meet installed. A VM cannot exercise ScreenCaptureKit.
- [ ] **Windows capture-exclusion probe in a real session.** An SSH session has no composited desktop, so `SetWindowDisplayAffinity` reports 0 there; run `npm run probe:stealth` from the console.
- [ ] **Ubuntu bridge hide/leak rows.** The D-Bus contract is covered by `npm run probe:ubuntu-bridge`; hiding during a real Chrome/OBS/Zoom share, the first-frame race and the canary OCR need a desktop session someone can watch. Until then those rows stay **untested** in `docs/STEALTH-MATRIX.md`.
- [ ] **macOS/Linux rows of `docs/STEALTH-MATRIX.md`** stay labelled *untested* until measured; the UI must not claim them.

## Design rules

1. Original MIT code only — no copied proprietary source.
2. Platform differences live behind `src/main/platform/`; everything degrades cleanly on all three OSes.
3. Pure policy in `src/shared/policy/*`, unit-tested and driveable from plain Node by `bench/`.
4. Capture and STT run in supervised workers, never inline in `main/index.ts`.
5. Prefer local-first (bundled model, local STT, local OCR); cloud only with the user's key.
6. A capability is `live` in `src/shared/features.ts` only when it is measured; otherwise it is `scaffold` or `planned`.
