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
      // Dev: vendored pack binary checked into build/bin/<platform>
      const platformDir = process.platform === 'win32' ? 'win32' : process.platform;
      candidates.push(path.join(app.getAppPath(), 'build', 'bin', platformDir, name));
      candidates.push(path.join(process.cwd(), 'build', 'bin', platformDir, name));
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
      return c;
    }
  }

  cachedFfmpeg = null;
  return null;
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
