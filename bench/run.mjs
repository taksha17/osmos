#!/usr/bin/env node
/**
 * OSMOS benchmark harness — Architecture v2, §13.2.
 *
 * Replays fixture event logs through a provider and reports latency, so routing,
 * prompt and trigger changes can be compared instead of judged by impression.
 *
 * Usage:
 *   npm run bench            # deterministic fake provider (no keys, no network)
 *   BENCH_PROVIDER_BASE_URL=https://... BENCH_PROVIDER_MODEL=... npm run bench
 *   npm run bench -- --no-doc   # skip appending to docs/BENCHMARKS.md
 *
 * Imports no Electron: only `src/shared/*` and the LLM adapter, both bundled
 * into `.bench-build/` on demand with the esbuild that ships as a devDependency.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, '.bench-build');
const fixturesDir = path.join(root, 'bench', 'fixtures', 'transcripts');
const resultsDir = path.join(root, 'bench', 'results');
const benchDoc = path.join(root, 'docs', 'BENCHMARKS.md');

const args = new Set(process.argv.slice(2));
const writeDoc = !args.has('--no-doc');

const FAKE_FIRST_TOKEN_MS = Number(process.env.BENCH_FAKE_FIRST_TOKEN_MS ?? 120);
const FAKE_TOKEN_MS = Number(process.env.BENCH_FAKE_TOKEN_MS ?? 6);
const FAKE_TOKENS = Number(process.env.BENCH_FAKE_TOKENS ?? 24);

async function bundle(relativeEntry, outfile) {
  await build({
    entryPoints: [path.join(root, relativeEntry)],
    outfile: path.join(buildDir, outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
  return import(pathToFileURL(path.join(buildDir, outfile)).href);
}

/** Deterministic provider: fixed first-token delay, fixed token cadence. */
function fakeProvider() {
  return {
    id: 'bench-fake',
    capabilities: { vision: false, streaming: true, maxContext: 0, local: true },
    async *stream(req) {
      const question = req.messages[req.messages.length - 1]?.content ?? '';
      const tokens = Array.from({ length: FAKE_TOKENS }, (_, i) => `t${i}`);
      for (let i = 0; i < tokens.length; i++) {
        await sleep(i === 0 ? FAKE_FIRST_TOKEN_MS : FAKE_TOKEN_MS);
        yield { kind: 'delta', text: `${i === 0 ? '' : ' '}${tokens[i]}` };
      }
      yield { kind: 'done' };
      void question;
    },
  };
}

function realProvider(llmModule) {
  return llmModule.llmProviderFromConfig({
    id: process.env.BENCH_PROVIDER_ID || 'litellm',
    label: 'bench',
    apiKey: process.env.BENCH_PROVIDER_API_KEY || '',
    baseUrl: process.env.BENCH_PROVIDER_BASE_URL,
    model: process.env.BENCH_PROVIDER_MODEL,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

async function measure(provider, question, mode) {
  const controller = new AbortController();
  const startedAt = performance.now();
  let firstTokenAt = 0;
  let tokens = 0;
  let text = '';

  for await (const chunk of provider.stream({
    system: `Benchmark replay (${mode}).`,
    messages: [{ role: 'user', content: question }],
    signal: controller.signal,
  })) {
    if (chunk.kind === 'delta') {
      if (!firstTokenAt) firstTokenAt = performance.now();
      tokens += 1;
      text += chunk.text;
    }
  }

  const finishedAt = performance.now();
  return {
    firstTokenMs: Math.round((firstTokenAt || finishedAt) - startedAt),
    totalMs: Math.round(finishedAt - startedAt),
    tokens,
    chars: text.length,
  };
}

async function main() {
  const hasRealProvider =
    Boolean(process.env.BENCH_PROVIDER_BASE_URL) && Boolean(process.env.BENCH_PROVIDER_MODEL);

  if (!fs.existsSync(fixturesDir)) {
    console.error(`[bench] no fixtures at ${path.relative(root, fixturesDir)}`);
    process.exit(1);
  }

  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  if (fixtureFiles.length === 0) {
    console.error('[bench] no *.jsonl fixtures found');
    process.exit(1);
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const events = await bundle('src/shared/events.ts', 'events.mjs');
  const router = await bundle('src/shared/policy/routerV2.ts', 'router.mjs');
  const trigger = await bundle('src/shared/policy/triggerPolicy.ts', 'trigger.mjs');
  const llm = await bundle('src/main/providers/llm/config.ts', 'llm.mjs');

  const provider = hasRealProvider ? realProvider(llm) : fakeProvider();
  const samples = [];
  const skipped = [];

  for (const file of fixtureFiles) {
    const log = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
    const parsed = events.parseEventLog(log);
    if (parsed.length === 0) continue;

    const sessionStart = parsed.find((e) => e.t === 'session.start');
    const mode = sessionStart?.mode ?? 'general';

    for (const utterance of parsed.filter((e) => e.t === 'utterance.final')) {
      // Only utterances the trigger policy would answer are worth measuring.
      // Self-speech, short filler and repeats never produce a request (§7.3).
      const decision = trigger.decideTrigger({
        text: utterance.text,
        channel: utterance.channel,
        smartMode: true,
      });
      if (!decision.fire) {
        skipped.push({ fixture: file, question: utterance.text, reason: decision.reason });
        continue;
      }

      const plan = router.planLanes({ question: utterance.text, mode });
      const metrics = await measure(provider, utterance.text, mode);
      samples.push({
        fixture: file,
        channel: utterance.channel,
        mode,
        question: utterance.text,
        lane: plan.decision.tier,
        tiers: plan.tiers,
        reason: plan.reason,
        ...metrics,
      });
    }
  }

  if (samples.length === 0) {
    console.error('[bench] fixtures contained no answerable utterances');
    process.exit(1);
  }

  const firstTokens = samples.map((s) => s.firstTokenMs);
  const totals = samples.map((s) => s.totalMs);
  const summary = {
    samples: samples.length,
    skipped: skipped.length,
    firstTokenP50: percentile(firstTokens, 50),
    firstTokenP95: percentile(firstTokens, 95),
    totalP50: percentile(totals, 50),
    totalP95: percentile(totals, 95),
    lanes: samples.reduce((acc, s) => {
      acc[s.lane] = (acc[s.lane] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    runAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    provider: provider.id,
    deterministic: !hasRealProvider,
    summary,
    samples,
    skipped,
  };

  fs.mkdirSync(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${stamp}.json`);
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);

  const table = [
    '| Fixture | Question | Lane | First token (ms) | Total (ms) |',
    '|---|---|---|---:|---:|',
    ...samples.map(
      (s) =>
        `| ${s.fixture.replace(/\.jsonl$/, '')} | ${s.question.slice(0, 60).replace(/\|/g, '\\|')} | ${s.lane} | ${s.firstTokenMs} | ${s.totalMs} |`,
    ),
  ].join('\n');

  if (writeDoc) {
    const section = [
      '',
      `## Run ${stamp}`,
      '',
      `- Platform: \`${report.platform}\` · Node ${report.node} · provider: \`${report.provider}\`${report.deterministic ? ' (deterministic fake)' : ''}`,
      `- Samples: ${summary.samples} · skipped by trigger policy: ${summary.skipped} · first token p50 **${summary.firstTokenP50} ms** / p95 ${summary.firstTokenP95} ms`,
      `- Lanes: ${JSON.stringify(summary.lanes)}`,
      '',
      table,
      '',
    ].join('\n');
    fs.appendFileSync(benchDoc, section);
  }

  console.log(
    `[bench] ${summary.samples} samples via ${report.provider} (${summary.skipped} skipped by trigger policy)`,
  );
  console.log(`[bench] first token p50=${summary.firstTokenP50}ms p95=${summary.firstTokenP95}ms`);
  console.log(`[bench] report → ${path.relative(root, resultPath)}`);
  if (writeDoc) console.log(`[bench] appended → ${path.relative(root, benchDoc)}`);
}

main().catch((error) => {
  console.error('[bench] failed:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
