#!/usr/bin/env node
/**
 * Stealth verification driver — Architecture v2, §11.
 *
 * Bundles `scripts/stealth-probe-main.ts` (which imports the shipped
 * `src/main/services/stealthWindow.ts`) and runs it under the project's Electron
 * on the current desktop, then prints the probe's JSON line.
 *
 *   npm run probe:stealth
 *
 * Exits non-zero when a check fails, so a matrix row can be produced by CI or by
 * hand without judgement calls.
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.stealth-probe');
const entry = path.join(root, 'scripts', 'stealth-probe-main.ts');
const outfile = path.join(outDir, 'main.mjs');
const TIMEOUT_MS = 180_000;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning',
});

/**
 * Locate the Electron binary without `require('electron')`, which throws when a
 * checkout has the dist folder but no `path.txt` (a common partial install).
 */
function resolveElectronBinary() {
  const pkgDir = path.join(root, 'node_modules', 'electron');
  const pathFile = path.join(pkgDir, 'path.txt');
  if (fs.existsSync(pathFile)) {
    const rel = fs.readFileSync(pathFile, 'utf8').trim();
    if (rel) return path.join(pkgDir, 'dist', rel);
  }
  const candidates = [
    path.join(pkgDir, 'dist', 'electron.exe'),
    path.join(pkgDir, 'dist', 'electron'),
    path.join(pkgDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) {
    throw new Error('Electron is not installed (run `npm install` or `node node_modules/electron/install.js`)');
  }
  return found;
}

const child = spawn(resolveElectronBinary(), [outfile], { stdio: 'inherit' });
const watchdog = setTimeout(() => {
  console.error(`[stealth-probe] timed out after ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  process.exitCode = 2;
}, TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(watchdog);
  process.exitCode = code ?? 1;
});
