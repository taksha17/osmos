# Benchmarks

Architecture v2 §13.2. Each `npm run bench` appends a section below; the raw
JSON lands in `bench/results/` (gitignored). Runs are host-specific — compare
only runs from the same machine.

## What is measured today (Phase 0)

| Metric | Status |
|---|---|
| First token after request start, fake provider | measured (deterministic, no keys) |
| First token after request start, real provider | opt-in via `BENCH_PROVIDER_BASE_URL` + `BENCH_PROVIDER_MODEL` |
| Lane chosen per fixture question | measured (`src/shared/policy/routerV2.ts`) |
| Utterances correctly skipped (self-speech / filler) | measured (`src/shared/policy/triggerPolicy.ts`) |
| End-of-speech → utterance handed to STT (p50 ≤ 600 ms) | measured 431 ms (Phase 2 slice 1); transcript timing needs `bench/fixtures/audio` |
| STT word error rate (≤ 12 %) | Phase 2 |
| Trigger precision ≥ 0.9 / recall ≥ 0.85 | Phase 3 — needs labelled transcripts |
| Vision key-fact recall | Phase 4 — needs `bench/fixtures/screens` |
| Idle CPU / RAM while listening | measured (Phase 1) |

## Phase 1 — runtime and capture (2026-11-20)

Host: Linux Zenbook, PipeWire/GNOME Wayland, sink monitor, 2 s chunks, room quiet.

| Check | Result |
|---|---|
| 30-minute soak | 899 chunks / 1 799 beats · max chunk gap **2 040 ms** (2 000 ms chunk + 1 frame) · 0 errors · 0 restarts |
| Idle cost while listening (4 samples, 15 s apart) | worker 1.3–1.7 % CPU / 46–47 MB RSS · ffmpeg 1.7 % CPU / 46 MB RSS → **≈3 % CPU, ≈93 MB total** |
| Worker with `node`+`ffmpeg` shimmed off PATH | pass — bundled Electron runtime, 5 chunks / 12 s, 0 errors |
| Windows `ELECTRON_RUN_AS_NODE` spike | pass — worker `ready`+`pong`, `onnxruntime-node` 1.24.3, Electron 34.5.8 / Node 20.19.1 |
| Supervisor restart | pass — kill → restart logged → capture resumed |
| Windows NSIS install, clean PATH | pass — installer 1.26 GB → silent install; with `node`/`python`/`ffmpeg`/`npm` absent from PATH: capture WAV chunks + Moonshine transcript from `resources/app.asar.unpacked`, app booted with `llama-server` child |
| Linux packaged tree, empty PATH | pass — `release/linux-unpacked` (AppImage 1.5 GB): real sink monitor through bundled ffmpeg + Moonshine transcript, 8/8 checks |
| Endpoint latency (Phase 2 slice 1) | 431 ms on a 1.2 s tone (hangover budget 450 ms) |

Not measured: STT word error rate and end-to-end transcript timing (no audio fixture
set yet), macOS packaging (no host), and live-device capture on the Windows box — it
enumerates no DirectShow audio endpoints, so that check drives the same worker and
bundled ffmpeg from a `lavfi` tone source instead.

CI runs the deterministic subset (unit tests) only; the benchmark is a local
and nightly tool.

## Run 2026-11-20T19-16-34-035Z

- Platform: `linux-x64` · Node v20.20.2 · provider: `bench-fake` (deterministic fake)
- Samples: 8 · skipped by trigger policy: 1 · first token p50 **120 ms** / p95 122 ms
- Lanes: {"fast":5,"quality":3}

| Fixture | Question | Lane | First token (ms) | Total (ms) |
|---|---|---|---:|---:|
| easy-question | What does JVM stand for? | fast | 122 | 269 |
| easy-question | What is a mutex? | fast | 120 | 265 |
| easy-question | What is 12 * 12? | fast | 121 | 266 |
| interview-basic | Tell me about a time you led a project. | quality | 120 | 264 |
| interview-basic | Tell me about yourself | quality | 120 | 265 |
| interview-basic | Why do you want to work here? | quality | 120 | 265 |
| meeting-action-item | Can you send the deck by Friday? | fast | 120 | 265 |
| meeting-action-item | We should probably revisit the pricing page copy before laun | fast | 120 | 266 |
