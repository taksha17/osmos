import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, env = {}) {
  return spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: false,
  });
}

await new Promise((resolve, reject) => {
  const build = run('node', ['scripts/build-electron.mjs']);
  build.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error('electron build failed'))));
});

const vite = run('npx', ['vite', '--port', '5179', '--strictPort']);
await new Promise((r) => setTimeout(r, 1500));

const electron = run('npx', ['electron', '.', '--no-sandbox'], { OSMOS_DEV: '1', UNCON_DEV: '1' });

const shutdown = () => {
  vite.kill('SIGTERM');
  electron.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

electron.on('exit', () => {
  vite.kill('SIGTERM');
  process.exit(0);
});
