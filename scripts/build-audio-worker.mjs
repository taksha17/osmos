#!/usr/bin/env node
/**
 * Build the OSMOS Python audio worker into a standalone executable with PyInstaller.
 *
 * Output: binaries/audio-worker/osmos-audio-worker[.exe]
 *
 * Run on the matching host OS (CI matrix builds linux/mac/win separately):
 *   node scripts/build-audio-worker.mjs
 *
 * Requires: python3 -m pip install pyinstaller numpy
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = path.join(root, 'src', 'python', 'audio_worker.py');
const outDir = path.join(root, 'binaries', 'audio-worker');
const workPath = path.join(root, 'binaries', '.pyinstaller-work');

function findPython() {
  const candidates =
    process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', 'python'];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('[audio-worker] No python3 found on PATH. Install Python 3.9+ and pyinstaller.');
  process.exit(1);
}

// CI runners don't ship PyInstaller — self-provision so pack steps never fail
// on environment drift (primary install lives in the workflow itself).
const hasPy = spawnSync(python, ['-c', 'import PyInstaller'], { encoding: 'utf8' }).status === 0;
if (!hasPy) {
  console.log('[audio-worker] PyInstaller missing — installing…');
  const pipArgs =
    process.platform !== 'win32'
      ? ['-m', 'pip', 'install', '--user', '--break-system-packages', 'pyinstaller', 'numpy']
      : ['-m', 'pip', 'install', 'pyinstaller', 'numpy'];
  const first = spawnSync(python, pipArgs, { stdio: 'inherit' });
  if (first.status !== 0 && process.platform !== 'win32') {
    spawnSync(python, ['-m', 'pip', 'install', '--user', 'pyinstaller', 'numpy'], {
      stdio: 'inherit',
    });
  }
}

if (!fs.existsSync(worker)) {
  console.error(`[audio-worker] Worker script missing at ${worker}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log(`[audio-worker] Building standalone binary with ${python}...`);
const res = spawnSync(
  python,
  [
    '-m',
    'PyInstaller',
    '--onefile',
    '--clean',
    '--noconfirm',
    '--name',
    'osmos-audio-worker',
    '--distpath',
    outDir,
    '--workpath',
    workPath,
    '--specpath',
    workPath,
    // Hide the console window on Windows builds.
    ...(process.platform === 'win32' ? ['--noconsole'] : []),
    worker,
  ],
  { stdio: 'inherit' },
);

fs.rmSync(workPath, { recursive: true, force: true });

if (res.status !== 0) {
  console.error('[audio-worker] PyInstaller build failed');
  process.exit(res.status ?? 1);
}

const ext = process.platform === 'win32' ? '.exe' : '';
const binary = path.join(outDir, `osmos-audio-worker${ext}`);
if (!fs.existsSync(binary)) {
  console.error(`[audio-worker] Expected binary missing at ${binary}`);
  process.exit(1);
}
fs.chmodSync(binary, 0o755);
console.log(`[audio-worker] Built ${binary} (${Math.round(fs.statSync(binary).size / 1024 / 1024)} MB)`);
