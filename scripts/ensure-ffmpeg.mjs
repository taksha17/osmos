#!/usr/bin/env node
/**
 * Ensure a platform-appropriate **LGPL** ffmpeg binary is vendored under
 * build/bin/<platform>/ so packaged installs are fully self-contained:
 * users install nothing manually on Windows, macOS, or Linux.
 *
 *   win32  → BtbN ffmpeg-master-latest-win64-lgpl.zip
 *   linux  → BtbN ffmpeg-master-latest-linux64-lgpl.tar.xz
 *   darwin → BtbN macos-arm64 / macos64 lgpl tar.xz (by host arch)
 *
 * LGPL keeps redistribution clean inside an MIT app (gyan "full/essentials"
 * builds are GPL). resolveBin.ts already searches build/bin/<platform>/ in dev
 * and resources/bin in packaged apps; package.json maps it via extraResources.
 *
 * Skips download when the target binary already exists (idempotent for CI).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'bin', process.platform === 'win32' ? 'win32' : process.platform);
const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const outExe = path.join(outDir, exeName);

const BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download';
/**
 * BtbN no longer publishes macOS assets in any release, so darwin compiles a
 * pinned upstream source tarball instead. Minimal config keeps the license
 * clean (LGPL — no GPL libs are autodetected or enabled) and trims build time;
 * avfoundation is a builtin demuxer and stays available.
 */
const FFMPEG_VERSION = '7.1.1';
function assetFor(platform, arch) {
  if (platform === 'win32') return `${BASE}/ffmpeg-master-latest-win64-lgpl.zip`;
  if (platform === 'linux') return `${BASE}/ffmpeg-master-latest-linux64-lgpl.tar.xz`;
  if (platform === 'darwin')
    return `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (/\.zip$/.test(archive)) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('unzip', ['-o', archive, '-d', dir], { stdio: 'inherit' });
    }
  } else {
    // .tar.xz — macOS/Linux CI hosts ship bsdtar/gnu tar with xz
    execFileSync('tar', ['-xJf', archive, '-C', dir], { stdio: 'inherit' });
  }
}

function findFfmpegBinary(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name.toLowerCase() === exeName.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

async function main() {
  const url = assetFor(process.platform, process.arch);
  if (!url) {
    console.error(`[ensure-ffmpeg] Unsupported platform ${process.platform}`);
    process.exit(1);
  }

  if (fs.existsSync(outExe)) {
    console.log(`[ensure-ffmpeg] already vendored: ${outExe}`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const archiveExt = url.endsWith('.zip') ? 'zip' : 'tar.xz';
  const archive = path.join(outDir, `ffmpeg-lgpl.${archiveExt}`);

  console.log(`[ensure-ffmpeg] downloading ${url}`);
  await download(url, archive);

  const extractDir = path.join(outDir, '_extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  try {
    extract(archive, extractDir);
    let found;
    if (process.platform === 'darwin') {
      // Compile minimal LGPL ffmpeg from pinned source (BtbN ships no macOS
      // builds). --disable-autodetect guarantees no GPL libraries link in;
      // avfoundation is builtin and remains enabled.
      const srcDir = path.join(extractDir, `ffmpeg-${FFMPEG_VERSION}`);
      const os = await import('node:os');
      const jobs = Math.max(2, os.cpus().length);
      execFileSync('./configure', ['--disable-debug', '--disable-doc', '--disable-autodetect', '--disable-network', '--disable-ffplay', '--disable-ffprobe'], {
        cwd: srcDir,
        stdio: 'inherit',
      });
      execFileSync('make', [`-j${jobs}`, 'ffmpeg'], { cwd: srcDir, stdio: 'inherit' });
      found = path.join(srcDir, 'ffmpeg');
    } else {
      found = findFfmpegBinary(extractDir);
    }
    if (!found) throw new Error(`${exeName} not produced`);
    fs.copyFileSync(found, outExe);
    fs.chmodSync(outExe, 0o755);
    // Stable staging dir consumed by electron-builder extraResources on ANY
    // host OS (avoids missing-dir errors for other platforms' entries).
    const stage = path.join(root, 'build', 'bin', 'current');
    fs.mkdirSync(stage, { recursive: true });
    const staged = path.join(stage, exeName);
    fs.copyFileSync(outExe, staged);
    fs.chmodSync(staged, 0o755);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(archive);
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(outExe)) throw new Error(`Failed to write ${outExe}`);
  const mb = Math.round(fs.statSync(outExe).size / 1024 / 1024);
  console.log(`[ensure-ffmpeg] vendored ${outExe} (${mb} MB)`);
}

main().catch((err) => {
  console.error('[ensure-ffmpeg]', err.message);
  process.exit(1);
});
