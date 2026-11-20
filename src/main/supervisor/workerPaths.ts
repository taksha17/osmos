/**
 * Worker script resolution — Architecture v2, §15 (zero-dependency runtime).
 *
 * Workers are plain `.mjs` files shipped with the app, not bundled by esbuild,
 * so they must be unpacked next to `app.asar` (Windows/macOS) or found in the
 * repo during development. Mirrors the whisper-worker lookup in
 * `services/localWhisper.ts` on purpose: one rule, one place to get wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

function isFile(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Absolute path to `src/workers/<...>` in dev, packaged, or unpacked builds. */
export function resolveWorkerScript(relative: string): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', relative));
    candidates.push(path.join(process.resourcesPath, relative));
  } catch {
    /* not Electron — dev/test */
  }
  try {
    candidates.push(path.join(app.getAppPath(), relative));
  } catch {
    /* ignore */
  }
  candidates.push(path.join(process.cwd(), relative));
  candidates.push(path.join(process.cwd(), '..', relative));

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Workers import tested shared policy, so they are bundled by
 * `scripts/build-workers.mjs` rather than shipped as loose source.
 */
export const CAPTURE_WORKER_REL = path.join(
  'dist-electron',
  'workers',
  'capture-worker.mjs',
);
