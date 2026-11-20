#!/usr/bin/env node
/**
 * Run every `*.test.ts` under `src/shared` on any supported Node version.
 *
 * The tests are TypeScript that rely on `node --test` type stripping, which needs
 * Node >= 22.18. Electron dev hosts may still run Node 20, so bundle each test
 * with the esbuild that already ships as a devDependency and then hand the built
 * `.mjs` files to `node --test` explicitly (a directory argument is resolved
 * differently across Node versions).
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = path.join(root, 'src', 'shared');
const outDir = path.join(root, '.test-build');

/** Every `*.test.ts` below `dir`, sorted, walked recursively. */
function collectTests(dir) {
  const found = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const sources = collectTests(sharedDir);

if (sources.length === 0) {
  console.error('[test] no src/shared/**/*.test.ts found');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const built = (
  await Promise.all(
    sources.map(async (source) => {
      const relative = path.relative(sharedDir, source).replace(/\.ts$/, '.mjs');
      const outfile = path.join(outDir, relative);
      await build({
        entryPoints: [source],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'warning',
      });
      return outfile;
    }),
  )
).sort();

const child = spawn(process.execPath, ['--test', ...built], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
