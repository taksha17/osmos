#!/usr/bin/env node
/**
 * Offline release helper — pack for THIS OS only, then upload to a GitHub Release.
 * Does not use GitHub Actions (saves Action minutes).
 *
 * Usage:
 *   node scripts/release-upload.mjs              # pack + upload using package.json version
 *   node scripts/release-upload.mjs --skip-pack  # upload existing release/ artifacts
 *   node scripts/release-upload.mjs --tag v0.6.0
 *
 * Requires: gh auth login, network for downloads (ffmpeg / bundled LLM) during pack.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const skipPack = args.includes('--skip-pack');
const tagArg = args.find((a) => a.startsWith('--tag='))?.slice(6) || (() => {
  const i = args.indexOf('--tag');
  return i >= 0 ? args[i + 1] : null;
})();

const version = String(pkg.version || '0.0.0');
const tag = tagArg || `v${version}`;

function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) process.exit(res.status || 1);
}

function packScript() {
  if (process.platform === 'linux') return 'pack:linux';
  if (process.platform === 'darwin') return 'pack:mac';
  if (process.platform === 'win32') return 'pack:win';
  throw new Error(`Unsupported platform ${process.platform}`);
}

function collectAssets() {
  const releaseDir = path.join(root, 'release');
  if (!fs.existsSync(releaseDir)) return [];
  const want =
    process.platform === 'linux'
      ? [/\.AppImage$/i, /\.deb$/i, /\.tar\.gz$/i]
      : process.platform === 'darwin'
        ? [/\.dmg$/i, /\.zip$/i, /\.pkg$/i]
        : [/\.exe$/i, /\.msi$/i];
  return fs
    .readdirSync(releaseDir)
    .filter((name) => want.some((re) => re.test(name)))
    .map((name) => path.join(releaseDir, name))
    .filter((p) => fs.statSync(p).isFile());
}

if (!skipPack) {
  run('npm', ['run', 'ensure:llm']);
  run('npm', ['run', packScript()]);
}

const assets = collectAssets();
if (!assets.length) {
  console.error('[release-upload] No installer assets in release/. Pack first.');
  process.exit(1);
}

console.log(`[release-upload] tag ${tag}`);
for (const a of assets) console.log(`  · ${path.basename(a)}`);

const existing = spawnSync('gh', ['release', 'view', tag], {
  cwd: root,
  encoding: 'utf8',
});

if (existing.status !== 0) {
  run('gh', [
    'release',
    'create',
    tag,
    ...assets,
    '--title',
    `OSMOS ${tag}`,
    '--notes',
    [
      `Offline-built ${process.platform} installers for OSMOS ${tag}.`,
      '',
      'Includes bundled fast LLM (Qwen2.5-0.5B Q4) when packaged with `ensure:llm`.',
      'Mac/Windows builds must be produced on those hosts and uploaded the same way.',
    ].join('\n'),
  ]);
} else {
  run('gh', ['release', 'upload', tag, ...assets, '--clobber']);
}

console.log(`[release-upload] done → https://github.com/${pkg.homepage?.replace(/^https:\/\/github.com\//, '') || 'taksha17/osmos'}/releases/tag/${tag}`);
