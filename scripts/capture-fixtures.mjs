#!/usr/bin/env node
/**
 * Fixture capture — Architecture v2, §13.2.
 *
 * The labelled sets in `bench/fixtures/` were written by hand and the rules were
 * tuned against them, so a perfect score there is a consistency check, not a
 * result. This script exists to make a real holdout cheap to produce: point it at
 * screenshots or a transcript you recorded, and it appends `split: "holdout"`
 * lines that `npm run bench` gates on instead of the tuning set.
 *
 * Screen snapshots (`--dir`): the label is the filename prefix, so a screenshot
 * needs no editing —
 *
 *   code-two-sum.png  → {"kind":"code"}      slide-roadmap.jpg → {"kind":"slide"}
 *   term-npm.png      → {"kind":"terminal"}  error-dialog.png  → {"kind":"error"}
 *   slide-*.png chat-*.png doc-*.jpg unknown-*.png
 *
 * OCR runs through the same tesseract.js version the app uses (`ocr.ts`), so the
 * text is what the chat path would actually see.
 *
 * Transcripts (`--file`): one utterance per line, TAB separated:
 *
 *   answer<TAB>How would you debug a stuck deploy?
 *   them<TAB>note<TAB>Alright, let's take that offline.
 *   me<TAB>none<TAB>Yes I agree.
 *
 * Usage:
 *   node scripts/capture-fixtures.mjs screen --dir ~/Pictures/osmos-holdout
 *   node scripts/capture-fixtures.mjs triggers --file ~/osmos-short-session.tsv
 *   ... --out bench/fixtures/screen/holdout.jsonl   # separate file instead
 *   ... --dry                                       # print, do not write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN_FIXTURES = path.join(root, 'bench', 'fixtures', 'screen', 'labelled.jsonl');
const TRIGGER_FIXTURES = path.join(root, 'bench', 'fixtures', 'triggers', 'labelled.jsonl');
const SCREEN_KINDS = ['code', 'terminal', 'error', 'slide', 'chat', 'document', 'unknown'];
const TRIGGER_LABELS = ['answer', 'note', 'none'];
const TRIGGER_CHANNELS = ['them', 'me'];

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { mode, flags };
}

function readExisting(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function appendLines(file, lines, dry) {
  if (dry) {
    for (const line of lines) console.log(line);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function screenId(kind, name) {
  const slug = name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `holdout-${kind}-${slug}`;
}

async function captureScreen(flags) {
  const dir = flags.dir && flags.dir !== true ? path.resolve(String(flags.dir)) : '';
  if (!dir || !fs.existsSync(dir)) {
    console.error('[capture] screen mode needs --dir <folder of png/jpg>');
    process.exit(1);
  }

  const out = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : SCREEN_FIXTURES;
  const existing = new Set(readExisting(out).map((item) => item.id));
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .sort();
  if (files.length === 0) {
    console.error(`[capture] no images in ${dir}`);
    process.exit(1);
  }

  let createWorker;
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch (error) {
    console.error(
      `[capture] tesseract.js is unavailable (${error instanceof Error ? error.message : error}). ` +
        'Run npm install first; the language data is the same one the app downloads.',
    );
    process.exit(1);
  }

  const worker = await createWorker('eng');
  const lines = [];
  const skipped = [];
  try {
    for (const name of files) {
      const kind = name.split(/[-_.]/)[0].toLowerCase();
      if (!SCREEN_KINDS.includes(kind)) {
        skipped.push({ name, reason: `filename must start with one of ${SCREEN_KINDS.join(" / ")}` });
        continue;
      }
      const id = screenId(kind, name);
      if (existing.has(id)) {
        skipped.push({ name, reason: `already captured as ${id}` });
        continue;
      }
      const { data } = await worker.recognize(path.join(dir, name));
      const text = String(data?.text ?? '').trim();
      if (!text) {
        skipped.push({ name, reason: 'OCR returned no text' });
        continue;
      }
      lines.push(JSON.stringify({ id, kind, text, split: 'holdout' }));
      existing.add(id);
      console.log(`[capture] ${name} → ${kind} (${text.length} chars)`);
    }
  } finally {
    await worker.terminate?.();
  }

  for (const item of skipped) console.warn(`[capture] skipped ${item.name}: ${item.reason}`);
  if (lines.length === 0) {
    console.log('[capture] nothing new to add');
    return;
  }
  appendLines(out, lines, Boolean(flags.dry));
  console.log(`[capture] ${lines.length} snapshot(s) → ${path.relative(root, out)}${flags.dry ? ' (dry run)' : ''}`);
}

function captureTriggers(flags) {
  const file = flags.file && flags.file !== true ? path.resolve(String(flags.file)) : '';
  if (!file || !fs.existsSync(file)) {
    console.error('[capture] triggers mode needs --file <tsv of label<TAB>text>');
    process.exit(1);
  }
  const out = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : TRIGGER_FIXTURES;
  const existing = new Set(readExisting(out).map((item) => item.id));

  const lines = [];
  const skipped = [];
  let index = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    index += 1;
    const parts = line.split('\t').map((part) => part.trim());
    const [channelOrLabel, maybeLabel, maybeText] = parts;
    const channel = TRIGGER_CHANNELS.includes(channelOrLabel) && parts.length === 3 ? channelOrLabel : 'them';
    const label = parts.length === 3 ? maybeLabel : channelOrLabel;
    const text = parts.length === 3 ? maybeText : maybeLabel;
    if (!TRIGGER_LABELS.includes(label) || !text) {
      skipped.push({ line: index, reason: 'expected label<TAB>text or channel<TAB>label<TAB>text' });
      continue;
    }
    const id = `holdout-trigger-${index}`;
    if (existing.has(id)) {
      skipped.push({ line: index, reason: `already captured as ${id}` });
      continue;
    }
    lines.push(JSON.stringify({ id, channel, expect: label, text, split: 'holdout' }));
    existing.add(id);
  }

  for (const item of skipped) console.warn(`[capture] skipped line ${item.line}: ${item.reason}`);
  if (lines.length === 0) {
    console.log('[capture] nothing new to add');
    return;
  }
  appendLines(out, lines, Boolean(flags.dry));
  console.log(`[capture] ${lines.length} utterance(s) → ${path.relative(root, out)}${flags.dry ? ' (dry run)' : ''}`);
}

const { mode, flags } = parseArgs(process.argv.slice(2));
if (mode === 'screen') await captureScreen(flags);
else if (mode === 'triggers') captureTriggers(flags);
else {
  console.error('usage: node scripts/capture-fixtures.mjs <screen --dir DIR | triggers --file TSV> [--out FILE] [--dry]');
  process.exit(1);
}
