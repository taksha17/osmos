#!/usr/bin/env node
/**
 * OCR extracted recording frames for the OSMOS overlay canary.
 *
 * Used by `linux/scripts/verify-capture.sh` when the host has no system
 * `tesseract`: the repo already ships tesseract.js, so the leak test works on a
 * stock Ubuntu box with only ffmpeg. Exit codes are the contract:
 *
 *   0  no canary in any frame
 *   1  canary found (the overlay leaked into the recording)
 *   2  the check could not run (missing frames / OCR failure)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWorker } from 'tesseract.js';

const dir = process.argv[2];
const canary = process.argv[3] || 'OSMOS-CANARY-7F3A';

if (!dir) {
  console.error('usage: ocr-canary.mjs <frames-dir> [canary]');
  process.exit(2);
}

const needle = canary.replace(/\s+/g, '').toLowerCase();
const frames = fs
  .readdirSync(dir)
  .filter((name) => /\.png$/i.test(name))
  .sort();

if (frames.length === 0) {
  console.error(`no PNG frames in ${dir}`);
  process.exit(2);
}

let worker;
try {
  worker = await createWorker('eng');
  let hits = 0;
  for (const frame of frames) {
    const { data } = await worker.recognize(path.join(dir, frame));
    const text = String(data?.text ?? '').replace(/\s+/g, '').toLowerCase();
    if (text.includes(needle)) {
      hits += 1;
      console.log(`LEAK frame: ${frame}`);
    }
  }
  console.log(`frames=${frames.length} canary_hits=${hits}`);
  process.exit(hits === 0 ? 0 : 1);
} catch (error) {
  console.error(`OCR failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
} finally {
  await worker?.terminate?.().catch(() => undefined);
}
