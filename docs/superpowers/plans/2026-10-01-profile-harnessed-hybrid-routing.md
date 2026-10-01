# Profile-Harnessed Local-First Hybrid Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route easy and anticipated questions to a bundled Qwen2.5-1.5B local model harnessed with profile data, with cloud-lane fallback, replacing the 0.5B bundle.

**Architecture:** Swap the vendored GGUF in `scripts/ensure-bundled-llm.mjs` + `bundledLlm.ts`; extend the pure router `routeDecision()` with an easy-question rule and a question-bank hint; match incoming questions against the active profile's bank in `buildChatContext()` and inject a grounding block; add cloud retry to direct fast-lane failures.

**Tech Stack:** Electron 34 main process, TypeScript (ESM, `.js` import extensions in compiled paths), llama.cpp `llama-server`, Node ≥ 22.18 built-in test runner (`node --test` with type stripping).

**Spec:** `docs/superpowers/specs/2026-10-01-profile-harnessed-hybrid-routing-design.md`

## Global Constraints

- Bundled llama-server resident RAM must stay **< 2 GB** (user hard requirement).
- Bundled model is exactly `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (986 MB) from `https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (Apache-2.0).
- llama.cpp pin stays `b10826`; model id stays `osmos-fast` (no settings migration).
- Never commit GGUF weights; they live under `build/llm/` (gitignored) → `extraResources`.
- System prompt is built only in main via `buildChatContext()`; renderer never sends prompt text.
- No new settings, no renderer/preload changes, no new npm dependencies.
- Main-process edits require `npm run build:electron` + dev restart to verify.
- Repo commit style: imperative one-liners like `Ship hybrid routing with bundled onboard LLM and offline releases.`

## Review Focus

1. **Paraphrased high-stakes question with no bank entry** (e.g. "give a quick summary of your career", ≤18 words) routes local in interview mode — accepted tradeoff, but any question containing a HIGH_STAKES_KEYWORD must stay `quality` — pinned by Task 2 tests.
2. **Degenerate bank entries** (short like "Salary?", or empty bank) must return `null` from the matcher, never crash or match everything — pinned by Task 1 tests.
3. **Local lane dies or returns empty mid-answer** → cloud retry recovers; an aborted stream during retry must still surface `Cancelled`, not a retry loop — pinned by Task 4 (code-path verification; IPC paths are not unit-testable in this repo).
4. **Screen context attached** must never route `fast`, even short/bank-less — pinned by Task 2 tests.
5. **RAM budget breach** — llama-server RSS must measure < 2 GB with the 1.5B model — pinned by Task 5 smoke step.

---

### Task 1: Question-bank matcher (pure) + test harness enablement

**Files:**
- Modify: `tsconfig.json`, `tsconfig.node.json` (add `"allowImportingTsExtensions": true`)
- Modify: `package.json` (add script `"test": "node --test src/shared/*.test.ts"`)
- Modify: `src/shared/types.ts` (`QuestionBankItem` gains `answer?: string`)
- Create: `src/shared/questionBank.ts`
- Create: `src/shared/questionBank.test.ts`

**Interfaces:**
- Consumes: `QuestionBankItem` from `src/shared/types.ts` (existing: `{ id, companyName, question, category, difficulty, tags, createdAt }`, gains optional `answer?: string`).
- Produces (Task 3 imports these):
  - `type QuestionBankMatch = { item: QuestionBankItem; similarity: number }`
  - `matchQuestionBank(incoming: string, bank: QuestionBankItem[]): QuestionBankMatch | null`
  - `const QUESTION_BANK_SIMILARITY_THRESHOLD = 0.5` (overlap coefficient: shared / min(|A|,|B|))
  - `const QUESTION_BANK_MIN_SHARED_TOKENS = 2`

- [ ] **Step 1: Write the failing test** — create `src/shared/questionBank.test.ts` using `import ... from './questionBank.ts'` and `import type { QuestionBankItem } from './types.ts'`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchQuestionBank,
  QUESTION_BANK_SIMILARITY_THRESHOLD,
  QUESTION_BANK_MIN_SHARED_TOKENS,
} from './questionBank.ts';
import type { QuestionBankItem } from './types.ts';

const item = (question: string, answer?: string): QuestionBankItem => ({
  id: 'q1',
  companyName: 'Acme',
  question,
  category: 'behavioral',
  difficulty: 'medium',
  tags: [],
  createdAt: 0,
  ...(answer !== undefined ? { answer } : {}),
});

test('exact match returns similarity 1 and surfaces answer', () => {
  const m = matchQuestionBank('Tell me about yourself', [item('Tell me about yourself', 'I build things.')]);
  assert.ok(m);
  assert.equal(m.similarity, 1);
  assert.equal(m.item.answer, 'I build things.');
});

test('paraphrase with synonym swap still matches at threshold', () => {
  // shared {what, your, strength} / min set size 4 = 0.75
  const m = matchQuestionBank('What is your biggest strength?', [item('What is your greatest strength?')]);
  assert.ok(m);
  assert.ok(m.similarity >= QUESTION_BANK_SIMILARITY_THRESHOLD);
});

test('unrelated question does not match', () => {
  assert.equal(matchQuestionBank('Explain the CAP theorem', [item('What is your favorite language?')]), null);
});

test('degenerate short entry and empty bank return null without crashing', () => {
  assert.equal(matchQuestionBank('What is the salary range?', [item('Salary?')]), null);
  assert.equal(matchQuestionBank('Anything', []), null);
});

test('best match wins across multiple entries', () => {
  const bank = [item('Explain microservices'), item('Why do you want to work here?')];
  const m = matchQuestionBank('Why do you want this job?', bank);
  assert.ok(m);
  assert.equal(m.item.question, 'Why do you want to work here?');
  assert.ok(m.similarity >= QUESTION_BANK_MIN_SHARED_TOKENS / 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/questionBank.test.ts`
Expected: FAIL — cannot find module `./questionBank.ts` (type stripping makes `.ts` imports runnable; file doesn't exist yet).

- [ ] **Step 3: Implement `src/shared/questionBank.ts`**

Add `"allowImportingTsExtensions": true` to both `tsconfig.json` and `tsconfig.node.json` (both already `noEmit: true`, so this is legal) — required for the test's `.ts`-extension imports to typecheck. Add `answer?: string` to `QuestionBankItem` in `src/shared/types.ts`. Add the `"test"` script to `package.json`.

Implement with this shape; the scoring algorithm is fixed by the spec:

```ts
import type { QuestionBankItem } from './types.js';

export const QUESTION_BANK_SIMILARITY_THRESHOLD = 0.5;
export const QUESTION_BANK_MIN_SHARED_TOKENS = 2;

export type QuestionBankMatch = { item: QuestionBankItem; similarity: number };

// Normalize exactly like stripOverlayEcho's normalizeLine/tokens in screenContext.ts:
// lowercase, non-alnum -> space; tokens length >= 3.
// Score = |A ∩ B| / min(|A|, |B|)  (overlap coefficient), requires >= QUESTION_BANK_MIN_SHARED_TOKENS
// shared tokens. Both token sets must be non-empty. Return the highest-scoring match
// at or above QUESTION_BANK_SIMILARITY_THRESHOLD, else null.
export function matchQuestionBank(incoming: string, bank: QuestionBankItem[]): QuestionBankMatch | null
```

Note the `./types.js` extension (compiled-path convention) in source files vs `./questionBank.ts` in test files (node-strip-types convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all `questionBank.test.ts` tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (test files included in both tsconfigs; `allowImportingTsExtensions` now permits the `.ts` imports).

- [ ] **Step 6: Commit**

```bash
git add tsconfig.json tsconfig.node.json package.json src/shared/types.ts src/shared/questionBank.ts src/shared/questionBank.test.ts
git commit -m "Add question-bank matcher for profile-harnessed local routing"
```

---

### Task 2: Route easy and bank-matched questions to the fast lane

**Files:**
- Modify: `src/shared/lumenRoute.ts`
- Create: `src/shared/lumenRoute.test.ts`

**Interfaces:**
- Consumes: existing `RouteDecision`, `RouteHints`, keyword lists, `kwMatch` in `lumenRoute.ts`.
- Produces: `RouteHints` gains `bankMatch?: boolean`; new export `const EASY_MAX_WORDS = 18`. Behavior consumed by Task 3 via `routeDecision(message, { mode, hasScreen, bankMatch })`.

- [ ] **Step 1: Write the failing test** — create `src/shared/lumenRoute.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision, EASY_MAX_WORDS } from './lumenRoute.ts';

test('easy short question routes fast even in interview mode', () => {
  const d = routeDecision('What does JVM stand for?', { mode: 'interview' });
  assert.equal(d.tier, 'fast');
  assert.equal(d.preferUpgrade, false);
});

test('high-stakes keyword still routes quality in interview mode', () => {
  const d = routeDecision('Tell me about yourself', { mode: 'interview' });
  assert.equal(d.tier, 'quality');
});

test('bank match routes fast unconditionally, overriding high-stakes phrasing', () => {
  const d = routeDecision('Why do you want to work here?', { mode: 'interview', bankMatch: true });
  assert.equal(d.tier, 'fast');
});

test('same question without bank match stays quality (high-stakes)', () => {
  const d = routeDecision('Why do you want to work here?', { mode: 'interview' });
  assert.equal(d.tier, 'quality');
});

test('screen context attached never routes fast', () => {
  const d = routeDecision('What does this screen show here', { mode: 'general', hasScreen: true });
  assert.equal(d.tier, 'quality');
});

test('complex keyword in a short question stays out of fast', () => {
  const d = routeDecision('Explain database indexing', { mode: 'general' });
  assert.notEqual(d.tier, 'fast');
});

test('forced tier still wins over easy and bank rules', () => {
  const d = routeDecision('What does JVM stand for?', { forceTier: 'quality' });
  assert.equal(d.tier, 'quality');
});

test('EASY_MAX_WORDS is 18', () => {
  assert.equal(EASY_MAX_WORDS, 18);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/lumenRoute.test.ts`
Expected: FAIL — `EASY_MAX_WORDS` not exported (interview mode currently sends "What does JVM stand for?" to `balanced`).

- [ ] **Step 3: Implement in `src/shared/lumenRoute.ts`**

Export `const EASY_MAX_WORDS = 18`. Add `bankMatch?: boolean` to `RouteHints`. In `routeDecision`, insert two rules **after the `force` check and the `SIMPLE_PATTERNS` loop, before the `HIGH_STAKES || mode === 'interview'` block** (order matters — bank match and easy must fire before the interview override):

```ts
if (hints.bankMatch) {
  return { tier: 'fast', reason: 'question-bank match', preferUpgrade: false };
}

if (!hints.hasScreen && words > 0 && words <= EASY_MAX_WORDS
    && !kwMatch(text, HIGH_STAKES_KEYWORDS)
    && !kwMatch(text, COMPLEX_KEYWORDS)) {
  return { tier: 'fast', reason: `easy question (${words} words)`, preferUpgrade: false };
}
```

Leave every later rule (interview override, hasScreen, quality-length, balanced default) untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all `lumenRoute.test.ts` and `questionBank.test.ts` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lumenRoute.ts src/shared/lumenRoute.test.ts
git commit -m "Route easy and bank-matched questions to the local fast lane"
```

---

### Task 3: Wire bank matching into buildChatContext and both chat handlers

**Files:**
- Modify: `src/main/index.ts` (`buildChatContext` ~line 134; `chat:ask` ~line 845; `chat:ask-stream` ~line 902)

**Interfaces:**
- Consumes: `matchQuestionBank`, `QuestionBankMatch` from `../shared/questionBank.js`; `activeSavedProfile`, `loadQuestionBank` (already imported in index.ts); Task 2's `bankMatch` hint.
- Produces: `buildChatContext` return type gains `bankMatch: QuestionBankMatch | null` (internal to main; no IPC surface change).

- [ ] **Step 1: Extend `buildChatContext`**

Near the top of the function (after `active` is resolved, before the interview-mode `prepBlock` section so it applies in **all** modes), compute the same bank source line 247 uses:

```ts
const bank = active.questions?.length ? active.questions : loadQuestionBank();
const bankMatch = matchQuestionBank(message, bank);
```

Add the grounding block to the system prompt when matched (uses the local `clip` helper):

```ts
const bankBlock = bankMatch
  ? `\n\n# Anticipated question\nThe incoming question matches one saved in the user's question bank (${bankMatch.item.companyName} · ${bankMatch.item.category}).${
      bankMatch.item.answer?.trim() ? `\nPrepared answer:\n${clip(bankMatch.item.answer, 1_500)}` : ''
    }\nAnswer with the user's own details above; do not invent.`
  : '';
```

Append `bankBlock` into the assembled system string wherever the other blocks (`profileBlock`, `agentBlock`, `docBlock`, `prepBlock`) are joined, and add `bankMatch` to the return object.

- [ ] **Step 2: Pass the hint in both handlers**

In `chat:ask` (~line 852) and `chat:ask-stream` (~line 908), change both `routeDecision(message, { mode, hasScreen })` calls to include `bankMatch: Boolean(bankMatch)` (destructure `bankMatch` from `buildChatContext`'s result in both).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build:electron`
Expected: exit 0 both.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "Ground chat context in matched question-bank entries and route on it"
```

---

### Task 4: Recover direct fast-lane failures via one cloud retry

**Files:**
- Modify: `src/main/index.ts` (`chat:ask` handler try/catch; `chat:ask-stream` non-upgrade branch ~line 989 and the empty-answer path)

**Interfaces:**
- Consumes: `plan.route.lane`, `plan.quality`, `plan.fast` from existing `LanePlan`; `ac.signal.aborted`; `emit`.
- Produces: no interface changes — behavior only.

- [ ] **Step 1: `chat:ask` non-stream retry**

In the `chat:ask` handler, wrap the `chatWithProvider(lane, ...)` call: on catch, if `ac`-equivalent abort doesn't apply here (non-stream has no controller — retry condition is just lane), when `plan.route.lane === 'fast' && plan.fast`, call `chatWithProvider(plan.quality, ...)` once and return that result (with its own try/catch surfacing the original-style error payload).

- [ ] **Step 2: `chat:ask-stream` direct-lane retry**

In the `else` branch (`const lane = directProvider(plan); trimmed = await pump(lane);`):
- Wrap in try/catch. On catch: if `ac.signal.aborted`, rethrow (the outer catch already emits `Cancelled`). Else if `plan.route.lane === 'fast' && plan.fast`, emit `{ type: 'status', text: 'Local model unavailable — answering with the full model…' }` and `trimmed = await pump(plan.quality)`; if that throws, let it propagate to the existing outer catch.
- In the existing `if (!trimmed)` empty-answer block below it, add the same recovery **before** emitting the empty-answer error: if `plan.route.lane === 'fast' && plan.quality`, retry `pump(plan.quality)` once and use its result if non-empty.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build:electron`
Expected: exit 0 both. Restart `npm run dev` and kill the bundled llama-server mid-session, then ask an easy question: expect the status line flips to the cloud model and an answer still arrives.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "Retry cloud lane when the local model fails or answers empty"
```

---

### Task 5: Swap the bundled model to Qwen2.5-1.5B and smoke-test RAM

**Files:**
- Modify: `scripts/ensure-bundled-llm.mjs` (MODEL_FILE, MODEL_URL, model.json label + source)
- Modify: `src/main/services/bundledLlm.ts` (fallback modelRel, `-n 512`)
- Modify: `THIRD-PARTY-NOTICES.md` (update the Qwen2.5-0.5B attribution to Qwen2.5-1.5B; Apache-2.0 text unchanged)
- Modify: `AGENTS.md` (hybrid-routing bullet: bundled fast lane is Qwen2.5-1.5B, ~1 GB, <2 GB RAM)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `build/llm/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` + `model.json` with `label: 'OSMOS Fast (Qwen2.5-1.5B)'`, `source: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF'` (id `osmos-fast` unchanged).

- [ ] **Step 1: Edit the constants**

In `ensure-bundled-llm.mjs`: `MODEL_FILE = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'`, `MODEL_URL = 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'`; in the `model.json` write, label `'OSMOS Fast (Qwen2.5-1.5B)'` and source `'bartowski/Qwen2.5-1.5B-Instruct-GGUF'`. In `bundledLlm.ts`: fallback `modelRel` `'models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'`; spawn arg `'-n', '256'` → `'-n', '512'`.

- [ ] **Step 2: Download and verify the file**

Run: `npm run ensure:llm`
Expected: downloads ~986 MB (one-time, slow); ends with `ready for linux/x64 (986.x MB model + llama-server)`. Confirm `ls -la build/llm/models/` shows the 1.5B file (~1.03e9 bytes) and no stale 0.5B requirement.

- [ ] **Step 3: Smoke-test the server and measure RAM**

Run:
```bash
./build/llm/runtime/llama-server -m build/llm/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf --host 127.0.0.1 --port 39281 -c 2048 -n 512 --alias osmos-fast &
sleep 20
curl -s http://127.0.0.1:39281/health
curl -s http://127.0.0.1:39281/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"osmos-fast","messages":[{"role":"user","content":"Say OK"}]}' | head -c 400
ps -o rss= -p "$(pgrep -f 'llama-server.*osmos-fast')"
kill %1
```
Expected: health `{"status":"ok"}`; completion JSON contains `"OK"`; RSS `< 2000000` (KB — under the 2 GB budget). Record the RSS number in the commit message body.

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build:electron`
Expected: exit 0 both.

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-bundled-llm.mjs src/main/services/bundledLlm.ts THIRD-PARTY-NOTICES.md AGENTS.md
git commit -m "Swap bundled local model to Qwen2.5-1.5B for real easy-question answers"
```

---

### Task 6: End-to-end dev validation

**Files:** none (verification only)

- [ ] **Step 1: Full build + restart**

Run: `npm run build:electron` then restart `npm run dev`.

- [ ] **Step 2: Scenario smoke (overlay or hub chat)**

With mode = interview and the existing OpenRouter provider config untouched:
1. Ask `What does JVM stand for?` → status shows `Quick local · osmos-fast`; answer arrives without API spend.
2. Ask `Tell me about a time you handled conflict` → status shows the cloud model (`Full model`).
3. In Profile → question bank, ensure an entry like `Why do you want to work here?` exists; ask it → status shows `Quick local` and the answer references profile/JD material.
4. Ask an easy question, then a hard one → the hard answer demonstrably uses the earlier exchange (history continuity).

- [ ] **Step 3: Final checks**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. Confirm `git status` clean of stray artifacts (no `build/llm` files staged — weights stay out of git).
