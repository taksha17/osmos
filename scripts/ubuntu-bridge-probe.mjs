#!/usr/bin/env node
/**
 * Run the Ubuntu bridge D-Bus contract probe (docs/UBUNTU-STEALTH-BRIDGE.md §11).
 *
 *   npm run probe:ubuntu-bridge
 *
 * Bundles `scripts/ubuntu-bridge-probe-main.ts` (so it drives the shipped
 * `src/main/platform/linux/gnomeBridge.ts`) and runs it under `dbus-run-session`,
 * which gives it a private session bus. Your real `org.osmos.Bridge` is never
 * touched, and no GNOME Shell restart is needed.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.ubuntu-bridge-probe');
const entry = path.join(root, 'scripts', 'ubuntu-bridge-probe-main.ts');
const outfile = path.join(outDir, 'probe.mjs');
const TIMEOUT_MS = 45_000;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  logLevel: 'warning',
});

const child = spawn('dbus-run-session', ['--', process.execPath, outfile], {
  stdio: 'inherit',
  cwd: root,
});

const timer = setTimeout(() => {
  console.error(`[ubuntu-bridge-probe] timed out after ${TIMEOUT_MS / 1000}s`);
  child.kill('SIGKILL');
  process.exit(1);
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('[ubuntu-bridge-probe] failed to start:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (signal) {
    console.error(`[ubuntu-bridge-probe] killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
