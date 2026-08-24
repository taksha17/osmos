import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const VITE_PORT = 5179;

function bin(name) {
  const local = path.join(root, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
  if (fs.existsSync(local)) return local;
  return isWin ? `${name}.cmd` : name;
}

function run(cmd, args, env = {}, opts = {}) {
  const needsShell = opts.shell ?? (isWin && /\.cmd$/i.test(cmd));
  return spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    // Only shell for Windows .cmd shims — bare node.exe paths with spaces break under cmd.exe.
    shell: needsShell,
  });
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve(null);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

await new Promise((resolve, reject) => {
  const build = run(process.execPath, ['scripts/build-electron.mjs'], {}, { shell: false });
  build.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error('electron build failed'))));
});

const vite = run(bin('vite'), ['--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort']);
await waitForPort(VITE_PORT);

const electron = run(bin('electron'), ['.', '--no-sandbox'], { OSMOS_DEV: '1', UNCON_DEV: '1' });

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
