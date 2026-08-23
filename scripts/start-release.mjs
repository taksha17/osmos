#!/usr/bin/env node
/**
 * Launch the packaged Linux build without FUSE (AppImage).
 * Prefer release/linux-unpacked — works on Ubuntu with only fuse3.
 *
 * Linux note: Electron/Chromium + GTK under Wayland can fatal on a GNOME
 * schema mismatch (`org.gnome.settings-daemon.plugins.xsettings` /
 * `antialiasing`). Force X11 for the child process — same workaround used
 * by many AppImages / Tauri builds.
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
    ? [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Prefer X11: Wayland + GTK schema mismatch fatal-aborts Electron on some Ubuntu/GNOME hosts.
        '--ozone-platform=x11',
        ...process.argv.slice(2),
      ]
    : process.argv.slice(2);

const env = { ...process.env };
if (process.platform === 'linux') {
  // Snap/Flatpak schema dirs + Wayland GDK backend cause:
  //   GLib-GIO-ERROR: Settings schema '...xsettings' does not contain key 'antialiasing'
  delete env.GSETTINGS_SCHEMA_DIR;
  delete env.GSETTINGS_BACKEND;
  env.GDK_BACKEND = 'x11';
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  // Drop snap/flatpak share dirs; keep system schemas.
  const kept = (process.env.XDG_DATA_DIRS || '')
    .split(':')
    .filter((p) => p && !/\/snap\//.test(p) && !/flatpak/.test(p));
  env.XDG_DATA_DIRS = kept.length ? kept.join(':') : '/usr/local/share:/usr/share';
}

const child = spawn(bin, launchArgs, {
  cwd: path.dirname(bin),
  stdio: 'inherit',
  env,
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
