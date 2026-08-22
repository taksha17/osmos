import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outMain = path.join(root, 'dist-electron/main');
const outPreload = path.join(root, 'dist-electron/preload');

fs.mkdirSync(outMain, { recursive: true });
fs.mkdirSync(outPreload, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(outMain, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(outPreload, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
});

console.log('[build-electron] done');
