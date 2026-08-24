#!/usr/bin/env node
/**
 * Package for the current OS only.
 * Cross-building mac/win from Linux (or vice versa) is unsupported here —
 * use pack:linux / pack:mac / pack:win on the matching machine, or CI.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targetByPlatform = {
  linux: ['--linux'],
  darwin: ['--mac'],
  win32: ['--win'],
};

const args = targetByPlatform[process.platform];
if (!args) {
  console.error(`[pack] Unsupported host platform: ${process.platform}`);
  process.exit(1);
}

async function ensureWinFfmpeg() {
  if (process.platform !== 'win32') return;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'ensure-ffmpeg-win.mjs')], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ensure-ffmpeg-win exited ${code}`))));
  });
}

await ensureWinFfmpeg();

console.log(`[pack] Host=${process.platform} → electron-builder ${args.join(' ')}`);

const child = spawn('npx', ['electron-builder', ...args, '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
