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
| End-of-question → final transcript (p50 ≤ 600 ms) | Phase 2 — needs `bench/fixtures/audio` |
| STT word error rate (≤ 12 %) | Phase 2 |
| Trigger precision ≥ 0.9 / recall ≥ 0.85 | Phase 3 — needs labelled transcripts |
| Vision key-fact recall | Phase 4 — needs `bench/fixtures/screens` |
| Idle CPU / RAM while listening | Phase 1 |

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
