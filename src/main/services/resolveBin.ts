/**
 * Resolve external CLI tools for spawn().
 * Bare names + broken PATH entries can throw spawn ENOTDIR (common on Windows
 * and when Electron packages set cwd to app.asar). Always prefer absolute paths.
 *
 * Hard rule: never rely on bare `ffmpeg` in packaged builds — use getFfmpegPath().
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

function isFile(p: string): boolean {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** PATH entries that are real directories (skip empty / file / missing). */
export function pathDirs(): string[] {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH || '')
    .split(sep)
    .map((d) => d.trim())
    .filter((d) => d && isDir(d));
}

export function findOnPath(command: string): string | null {
  const names =
    process.platform === 'win32'
      ? command.endsWith('.exe') || command.endsWith('.cmd') || command.endsWith('.bat')
        ? [command]
        : [`${command}.exe`, `${command}.cmd`, command]
      : [command];

  for (const dir of pathDirs()) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function ffmpegBinaryName(): string {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** Known manual-install locations (Windows). */
function knownInstallFfmpeg(): string[] {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(programFilesX86, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  ];
}

/** ffmpeg next to the packaged app / extraResources / common installs. */
export function findBundledFfmpeg(): string | null {
  const name = ffmpegBinaryName();
  const candidates: string[] = [];
  try {
    // electron-builder extraResources → resources/bin/ffmpeg.exe
    candidates.push(path.join(process.resourcesPath, 'bin', name));
    candidates.push(path.join(process.resourcesPath, name));
    candidates.push(path.join(path.dirname(process.execPath), name));
    candidates.push(path.join(path.dirname(process.execPath), 'bin', name));
    if (app.isPackaged) {
      candidates.push(path.join(path.dirname(app.getPath('exe')), name));
      candidates.push(path.join(path.dirname(app.getPath('exe')), 'resources', 'bin', name));
    } else {
      // Dev: vendored pack binary checked into build/bin/<platform>. `current`
      // is the staging copy ensure-ffmpeg.mjs also writes (and extraResources
      // ships), so a dev run sees the same binary as the packaged app.
      const platformDir = process.platform === 'win32' ? 'win32' : process.platform;
      for (const dir of [platformDir, 'current']) {
        candidates.push(path.join(app.getAppPath(), 'build', 'bin', dir, name));
        candidates.push(path.join(process.cwd(), 'build', 'bin', dir, name));
      }
    }
  } catch {
    /* ignore */
  }
  candidates.push(...knownInstallFfmpeg());
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

let cachedFfmpeg: string | null | undefined;
/** Set when an ffmpeg file exists but will not execute (policy block, bad DLLs). */
let ffmpegProbeFailure: string | null = null;
/** When the last failed resolution ran, so an explicit retry can re-probe. */
let lastFailedProbeAt = 0;

function probeFfmpeg(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to a working ffmpeg, or null if none found. */
export function resolveFfmpeg(): string | null {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;

  const candidates = [
    findBundledFfmpeg(),
    findOnPath('ffmpeg'),
    ...knownInstallFfmpeg(),
  ].filter((c): c is string => Boolean(c));

  const seen = new Set<string>();
  for (const c of candidates) {
    const key = path.normalize(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isFile(c)) continue;
    if (probeFfmpeg(c)) {
      cachedFfmpeg = c;
      ffmpegProbeFailure = null;
      return c;
    }
    // The file is there but cannot run — remember where, so callers can say
    // "blocked/unusable" instead of the misleading "ffmpeg is required".
    ffmpegProbeFailure = c;
  }

  cachedFfmpeg = null;
  lastFailedProbeAt = Date.now();
  return null;
}

/**
 * Drop a failed ffmpeg resolution so the next attempt probes again — used when
 * the user explicitly retries after installing/allowing a binary. The previous
 * result is kept for a minute so a hung probe cannot stall every retry.
 */
export function resetFfmpegCache(minIntervalMs = 60_000): void {
  if (cachedFfmpeg) return;
  if (Date.now() - lastFailedProbeAt < minIntervalMs) return;
  cachedFfmpeg = undefined;
  ffmpegProbeFailure = null;
}

/**
 * Why no ffmpeg was resolved, in words a user can act on. Returns null when an
 * ffmpeg does resolve, and a generic message when nothing was found at all.
 */
export function describeFfmpegProblem(): string | null {
  if (resolveFfmpeg()) return null;
  if (ffmpegProbeFailure) {
    return `ffmpeg is present at ${ffmpegProbeFailure} but will not run (blocked by device policy, or missing DLLs). Install a runnable ffmpeg or allow that binary.`;
  }
  return 'ffmpeg was not found. Install ffmpeg (or allow the bundled copy) for continuous capture.';
}

/**
 * Always returns a path string for spawn.
 * Prefer resolveFfmpeg(); bare name is last-resort PATH lookup only (dev).
 */
export function getFfmpegPath(): string {
  return resolveFfmpeg() || ffmpegBinaryName();
}

export function resolveCaptureTool(command: string): string | null {
  if (command === 'ffmpeg') return resolveFfmpeg();
  return findOnPath(command);
}

/** Real directory for spawn cwd — never app.asar (file → ENOTDIR). */
export function safeSpawnCwd(preferred?: string): string {
  if (preferred && isDir(preferred)) return preferred;
  try {
    if (app.isPackaged && isDir(process.resourcesPath)) return process.resourcesPath;
  } catch {
    /* ignore */
  }
  const tmp = app.getPath('temp');
  if (isDir(tmp)) return tmp;
  return process.cwd();
}

export function isExecutableFile(p: string): boolean {
  return isFile(p);
}
