#!/usr/bin/env node
/**
 * Run the pure `src/shared/*.test.ts` suites on any supported Node version.
 *
 * The tests are TypeScript that rely on `node --test` type stripping, which needs
 * Node >= 22.18. Electron dev hosts may still run Node 20, so bundle each test
 * with the esbuild that already ships as a devDependency and then run node --test.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = path.join(root, 'src', 'shared');
const outDir = path.join(root, '.test-build');

const files = fs
  .readdirSync(sharedDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('[test] no src/shared/*.test.ts found');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await Promise.all(
  files.map((file) =>
    build({
      entryPoints: [path.join(sharedDir, file)],
      outfile: path.join(outDir, file.replace(/\.ts$/, '.mjs')),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'warning',
    }),
  ),
);

const child = spawn(process.execPath, ['--test', outDir], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
