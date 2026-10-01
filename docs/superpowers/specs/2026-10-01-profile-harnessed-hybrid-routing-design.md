# Profile-Harnessed Local-First Hybrid Routing — Design

**Date:** 2026-10-01
**Status:** Approved in session (brainstorming) — user RAM constraint: bundled model must hold **< 2 GB RAM**
**Implements on:** `main`

## Goal

Easy questions get answered directly by a bundled local model harnessed with the user's
profile details; harder questions go to the configured cloud provider (unchanged — the
"nim key" / OpenRouter config stays exactly as-is). The cloud is never out of context:
locally-answered turns join conversation history and reach the cloud on its next call.

## Approved decisions

1. **Bundled model swap:** Qwen2.5-0.5B → **Qwen2.5-1.5B-Instruct Q4_K_M** (986 MB,
   Apache-2.0, `bartowski/Qwen2.5-1.5B-Instruct-GGUF`). Runtime RAM ≈ 1.2–1.4 GB —
   ~40% headroom under the 2 GB cap. Model id stays `osmos-fast` (no settings
   migration). llama.cpp pin `b10826` unchanged (already runs Qwen2.5). Max output
   tokens `-n 256` → `512`; context `-c 2048` unchanged. One bundled model serves both
   easy-answer and quick-draft lanes.
2. **Rejected:** `gemma4:e2b` (smallest usable quant is a 2.29 GB file — breaks the RAM
   budget), dual-model bundles (RAM + complexity, no gain), Ollama-only local lane
   (violates "bundle it" requirement).
3. **Routing** (`src/shared/lumenRoute.ts`):
   - New easy-question rule: ≤ 18 words, no high-stakes keyword, no complex keyword,
     no screen context → `fast` tier **even in interview mode**.
   - Question-bank match → `fast` tier unconditionally (the question was anticipated;
     answer is grounded in the user's own data).
   - Unchanged: high-stakes keywords, screen context, long/complex prompts → quality
     lane; medium → balanced (draft-then-upgrade).
4. **Question-bank harness:** new pure helper in `src/shared/questionBank.ts`.
   Matching = token-set overlap coefficient ≥ **0.5** over normalized tokens (≥ 3
   chars), requiring ≥ **2 shared tokens** — same normalization philosophy as
   `stripOverlayEcho` in `shared/screenContext.ts`. `QuestionBankItem` gains an
   optional `answer?: string` (backwards-compatible; no renderer UI change). On a
   match, main injects an "Anticipated question" grounding block into the system
   prompt so the local model polishes the user's own material instead of inventing.
   Matching runs in `buildChatContext()` in main, before routing, in all modes.
5. **Context continuity (cloud never out of the loop):** no parallel cloud calls.
   Locally-answered turns join the renderer history (last 12 turns), which is resent
   with every request — the cloud sees all prior local Q&A the moment it answers.
6. **Failure recovery:** if the fast lane fails (stream error or empty answer) and the
   stream was not aborted, retry once on the quality lane before surfacing an error.
   The draft path already does this; the direct-lane paths (`chat:ask` non-stream and
   the non-upgrade stream branch) gain it.
7. **No new settings, no renderer changes, no preload changes.** `hybridRouting`,
   `hybridFastModel`, `draftThenUpgrade`, provider config all unchanged.

## Known tradeoffs (accepted)

- A ≤ 18-word substantive question that hits no keyword (e.g. "give a quick summary of
  your career") routes local in interview mode. Accepted: the local model still has the
  full profile in its system prompt; high-stakes phrasings are keyword-caught.
- Two similar personal bank questions can cross-match (low harm — answer is still
  grounded in the user's profile).

## Verification

- Unit tests: `node --test src/shared/*.test.ts` (Node ≥ 22.18 type-stripping; add
  `allowImportingTsExtensions` to both tsconfigs).
- `npm run typecheck`, `npm run build:electron`, restart `npm run dev`.
- llama-server RSS < 2 GB after loading the 1.5B model.
- Dev smoke: easy question in interview mode → "Quick local"; behavioral question →
  cloud; bank question → "Quick local".
