#!/usr/bin/env node
/**
 * Bundle the isolated workers into `dist-electron/workers/`.
 *
 * Workers are plain Node ESM, launched from main with `ELECTRON_RUN_AS_NODE`,
 * but they import shared policy modules (`src/shared/policy/*`) so the tested
 * implementation is the shipped one. esbuild inlines them; `electron-builder`
 * unpacks `dist-electron/workers/**` from the asar so `spawn` can run them.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-electron', 'workers');

const ENTRIES = ['src/workers/capture/capture-worker.ts'];

fs.mkdirSync(outDir, { recursive: true });

await Promise.all(
  ENTRIES.map((entry) =>
    build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outDir, `${path.basename(entry, '.ts')}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: true,
      logLevel: 'warning',
    }),
  ),
);

console.log(`[build-workers] ${ENTRIES.length} worker(s) → dist-electron/workers`);
