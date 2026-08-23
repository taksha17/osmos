/**
 * Resolve external CLI tools for spawn().
 * Bare names + broken PATH entries can throw spawn ENOTDIR (common on Windows
 * and when Electron packages set cwd to app.asar). Always prefer absolute paths.
 */

import fs from 'node:fs';
import path from 'node:path';
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

/** ffmpeg next to the packaged app (Windows NSIS may drop ffmpeg.exe in install dir). */
export function findBundledFfmpeg(): string | null {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(process.execPath), name));
    candidates.push(path.join(process.resourcesPath, name));
    candidates.push(path.join(process.resourcesPath, 'bin', name));
    if (app.isPackaged) {
      candidates.push(path.join(path.dirname(app.getPath('exe')), name));
    }
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

export function resolveFfmpeg(): string | null {
  return findBundledFfmpeg() || findOnPath('ffmpeg');
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
