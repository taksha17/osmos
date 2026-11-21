#!/usr/bin/env node
/**
 * Package for the current OS only.
 * Cross-building mac/win from Linux (or vice versa) is unsupported here —
 * use pack:linux / pack:mac / pack:win on the matching machine, then
 * `npm run release:upload` (no GitHub Actions pack matrix).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script)], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });
}

// `--skip-vendor` reuses artefacts already staged (CI builds full then lite).
const skipVendor = process.argv.includes('--skip-vendor');
if (!skipVendor) {
  await runNode('ensure-ffmpeg.mjs');
  await runNode('ensure-bundled-llm.mjs');
}

/**
 * `--lite` (Architecture v2 §15): ship the llama-server runtime but not the GGUF
 * weights. The app downloads and SHA-256-verifies them on first run, so the
 * installer drops from ~1.3 GB to a few hundred MB.
 */
const lite = process.argv.includes('--lite');
const configArgs = [];
if (lite) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const config = structuredClone(pkg.build);
  config.extraResources = (config.extraResources || []).filter((entry) => entry.to !== 'llm');
  config.extraResources.push({
    from: 'build/llm',
    to: 'llm',
    filter: ['**/*', '!models/**', '!**/_extract/**', '!**/*.partial', '!**/*.tar.gz', '!**/*.zip'],
  });
  config.artifactName = '${productName}-${version}-lite-${os}-${arch}.${ext}';
  const configPath = path.join(root, 'electron-builder.lite.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  configArgs.push('--config', configPath);
  console.log('[pack] lite build — weights are downloaded on first run');
}

console.log(`[pack] Host=${process.platform} → electron-builder ${[...args, ...configArgs].join(' ')}`);

const child = spawn('npx', ['electron-builder', ...args, ...configArgs, '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
