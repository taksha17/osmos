#!/usr/bin/env node
/**
 * Download a static Windows ffmpeg.exe into build/bin/win32 for electron-builder
 * extraResources. Run automatically before pack:win / pack on Windows.
 *
 * Uses the gyan.dev **full** build (not essentials) because essentials lacks the
 * WASAPI demuxer required for speaker/meeting loopback. See THIRD-PARTY-NOTICES.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'bin', 'win32');
const outExe = path.join(outDir, 'ffmpeg.exe');
const ZIP_URL =
  process.env.OSMOS_FFMPEG_URL ||
  'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-full_build.zip';

function existsExe(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 1_000_000;
  } catch {
    return false;
  }
}

function supportsWasapi(exe) {
  try {
    const out = execFileSync(exe, ['-hide_banner', '-demuxers'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return /\bwasapi\b/i.test(out);
  } catch {
    return false;
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          const file = createWriteStream(dest);
          pipeline(res, file).then(resolve).catch(reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  const force = process.env.OSMOS_FORCE_FFMPEG_WIN === '1';
  if (process.platform !== 'win32' && !force) {
    console.log('[ensure-ffmpeg-win] skip (not Windows host)');
    return;
  }

  if (!force && existsExe(outExe)) {
    console.log(`[ensure-ffmpeg-win] already present: ${outExe}`);
    return;
  }

  // Note: modern ffmpeg Windows builds do not include a WASAPI demuxer.
  // OSMOS uses Chromium desktop loopback for Windows system audio instead.
  // We still vendor ffmpeg for any remaining CLI capture helpers / future use.

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, 'ffmpeg-release-full.zip');
  console.log(`[ensure-ffmpeg-win] downloading ${ZIP_URL}`);
  await download(ZIP_URL, zipPath);

  const extractDir = path.join(outDir, '_extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
  }

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (name.toLowerCase() === 'ffmpeg.exe') {
        return full;
      }
    }
    return null;
  }

  const found = walk(extractDir);
  if (!found) {
    throw new Error('ffmpeg.exe not found inside downloaded zip');
  }
  fs.copyFileSync(found, outExe);
  fs.rmSync(extractDir, { recursive: true, force: true });
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }

  if (!existsExe(outExe)) {
    throw new Error(`Failed to write ${outExe}`);
  }
  const wasapi = supportsWasapi(outExe);
  console.log(
    `[ensure-ffmpeg-win] ready: ${outExe} (${Math.round(fs.statSync(outExe).size / 1e6)} MB)` +
      (wasapi ? ' [WASAPI demuxer present]' : ' [no WASAPI — Windows loopback uses Chromium desktop capture]'),
  );
}

main().catch((err) => {
  console.error('[ensure-ffmpeg-win]', err instanceof Error ? err.message : err);
  process.exit(1);
});
