#!/usr/bin/env node
/**
 * Ensure the standalone audio worker binary exists before dev/pack.
 * - Skips silently if already built.
 * - Builds via PyInstaller when python3 + pyinstaller are available.
 * - Never fails the parent command: OSMOS's native audio pipeline
 *   (ffmpeg pulse / pw-record) still works without the Python worker.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const binary = path.join(root, 'binaries', 'audio-worker', `osmos-audio-worker${ext}`);

if (fs.existsSync(binary)) {
  process.exit(0);
}

function pythonBin() {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const bin of candidates) {
    if (spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0) return bin;
  }
  return null;
}

const py = pythonBin();
if (!py) {
  console.log('[audio-worker] python3 not found — skipping frozen worker build (native audio pipeline still works).');
  process.exit(0);
}

const hasPyInstaller =
  spawnSync(py, ['-c', 'import PyInstaller'], { encoding: 'utf8' }).status === 0;
if (!hasPyInstaller) {
  console.log('[audio-worker] Building frozen audio worker (one-time, ~30s)…');
  const pip = spawnSync(py, ['-m', 'pip', 'install', '--user', 'pyinstaller'], { stdio: 'ignore' });
  if (pip.status !== 0) {
    console.log('[audio-worker] Could not install pyinstaller — skipping (non-fatal).');
    process.exit(0);
  }
}

const res = spawnSync('node', [path.join(root, 'scripts', 'build-audio-worker.mjs')], {
  stdio: 'inherit',
});
if (res.status !== 0) {
  console.log('[audio-worker] Frozen worker build failed — continuing anyway (non-fatal).');
}
process.exit(0);
