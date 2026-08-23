#!/usr/bin/env node
/**
 * Launch the packaged Linux build without FUSE (AppImage).
 * Prefer release/linux-unpacked — works on Ubuntu with only fuse3.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const candidates =
  process.platform === 'linux'
    ? [
        path.join(root, 'release', 'linux-unpacked', 'osmos'),
        path.join(root, 'release', 'linux-unpacked', 'OSMOS'),
        path.join(root, 'release', 'linux-unpacked', 'unconventionally'),
        path.join(root, 'release', 'linux-unpacked', 'Unconventionally'),
      ]
    : process.platform === 'darwin'
      ? [
          path.join(root, 'release', 'mac', 'OSMOS.app', 'Contents', 'MacOS', 'OSMOS'),
          path.join(root, 'release', 'mac', 'Unconventionally.app', 'Contents', 'MacOS', 'Unconventionally'),
        ]
      : [
          path.join(root, 'release', 'win-unpacked', 'OSMOS.exe'),
          path.join(root, 'release', 'win-unpacked', 'Unconventionally.exe'),
        ];

const bin = candidates.find((p) => fs.existsSync(p));
if (!bin) {
  console.error(
    '[start:release] No packaged binary found.\n' +
      '  Run: npm run pack\n' +
      '  Then: npm run start:release\n' +
      '  (On Linux, do not double-click the AppImage unless libfuse2 is installed.)',
  );
  process.exit(1);
}

console.log(`[start:release] ${bin}`);
const launchArgs =
  process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--ozone-platform-hint=auto', ...process.argv.slice(2)]
    : process.argv.slice(2);

// On Linux, a snap-launched Code editor can export GSETTINGS_SCHEMA_DIR to a
// snap schema dir that lacks org.gnome.settings-daemon.plugins.xsettings.
// GTK then fatals on the missing 'antialiasing' key at startup. Neutralize it.
const env = { ...process.env };
if (process.platform === 'linux') {
  delete env.GSETTINGS_SCHEMA_DIR;
  delete env.GSETTINGS_BACKEND;
}

const child = spawn(bin, launchArgs, {
  cwd: path.dirname(bin),
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 1));
