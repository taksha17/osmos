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

console.log(`[pack] Host=${process.platform} → electron-builder ${args.join(' ')}`);

const child = spawn('npx', ['electron-builder', ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
