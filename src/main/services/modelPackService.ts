/**
 * Model pack download — Architecture v2 §15, Phase 7.
 *
 * The full installer ships the GGUF; the lite installer ships only the
 * llama-server runtime and fetches the weights on first run. This module owns the
 * HTTP half (resumable download, SHA-256 verification, atomic rename) while the
 * decisions live in `shared/policy/modelPack.ts` so they can be tested without a
 * network.
 *
 * Rules:
 * - Never write over an existing model: download to `<file>.partial`, verify, then
 *   rename in the same directory.
 * - Resume only when the server honours Range; otherwise truncate and restart.
 * - A hash mismatch deletes the partial and fails loudly — a corrupt 1 GB GGUF
 *   would otherwise surface as a model that loads and answers nothing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import {
  downloadRatio,
  packStatus,
  resumePlan,
  type ModelPackManifest,
  type PackStatus,
} from '../../shared/policy/modelPack.js';

export type ModelPackProgress = {
  bytes: number;
  expectedBytes: number | null;
  ratio: number;
  phase: 'downloading' | 'verifying' | 'done';
};

export function readPackManifest(root: string): ModelPackManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'model.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.file !== 'string') return null;
    return parsed as ModelPackManifest;
  } catch {
    return null;
  }
}

function statSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export function modelPackPaths(root: string, manifest: ModelPackManifest | null) {
  const relative = manifest?.file || 'models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf';
  const file = path.join(root, relative);
  return { root, file, partial: `${file}.partial` };
}

export function modelPackStatus(root: string): PackStatus & {
  manifest: ModelPackManifest | null;
  file: string;
} {
  const manifest = readPackManifest(root);
  const { file, partial } = modelPackPaths(root, manifest);
  const status = packStatus({
    fileBytes: statSize(file),
    partialBytes: statSize(partial),
    expectedBytes: manifest?.bytes ?? null,
    hasSha256: Boolean(manifest?.sha256),
  });
  return { ...status, manifest, file };
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export type DownloadResult = {
  ok: boolean;
  bytes: number;
  error?: string;
  resumedFrom: number;
  sha256?: string;
};

/**
 * Download (or resume) the pack and verify it.
 *
 * `onProgress` fires at most every `progressMs` so a 1 GB fetch does not flood
 * the event loop; the final call always reports `phase: 'done'`.
 */
export async function downloadModelPack(opts: {
  url: string;
  destPath: string;
  sha256?: string;
  expectedBytes?: number | null;
  signal?: AbortSignal;
  onProgress?: (progress: ModelPackProgress) => void;
  progressMs?: number;
}): Promise<DownloadResult> {
  const { url, destPath, expectedBytes = null, signal, onProgress } = opts;
  const partial = `${destPath}.partial`;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const partialBytes = statSize(partial) ?? 0;
  const headers: Record<string, string> = {};
  if (partialBytes > 0) headers.Range = `bytes=${partialBytes}-`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal, redirect: 'follow' });
  } catch (error) {
    return {
      ok: false,
      bytes: partialBytes,
      resumedFrom: partialBytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const plan = resumePlan({
    partialBytes,
    status: response.status,
    contentRange: response.headers.get('content-range'),
    expectedBytes,
  });

  if (plan.mode === 'complete') {
    // A previous run fully downloaded but died before the rename.
    const verified = await finishDownload(partial, destPath, opts.sha256, onProgress);
    return { ...verified, resumedFrom: partialBytes };
  }

  if (!response.ok && response.status !== 206) {
    return {
      ok: false,
      bytes: partialBytes,
      resumedFrom: partialBytes,
      error: `HTTP ${response.status} ${response.statusText}`.trim(),
    };
  }
  if (!response.body) {
    return { ok: false, bytes: partialBytes, resumedFrom: partialBytes, error: 'empty response body' };
  }

  const resumedFrom = plan.mode === 'resume' ? plan.start : 0;
  const out = fs.createWriteStream(partial, { flags: plan.mode === 'resume' ? 'a' : 'w' });
  let written = resumedFrom;
  let lastProgress = 0;
  const progressMs = opts.progressMs ?? 500;

  const report = (phase: ModelPackProgress['phase'], force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < progressMs) return;
    lastProgress = now;
    onProgress?.({
      bytes: written,
      expectedBytes,
      ratio: downloadRatio(written, expectedBytes),
      phase,
    });
  };

  try {
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      written += buf.length;
      if (!out.write(buf)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
      report('downloading');
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (error) {
    out.destroy();
    return {
      ok: false,
      bytes: written,
      resumedFrom,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  report('downloading', true);
  const verified = await finishDownload(partial, destPath, opts.sha256, onProgress);
  return { ...verified, resumedFrom };
}

/** Verify the completed partial and move it into place; delete it on mismatch. */
async function finishDownload(
  partial: string,
  destPath: string,
  sha256: string | undefined,
  onProgress?: (progress: ModelPackProgress) => void,
): Promise<DownloadResult> {
  const bytes = statSize(partial) ?? 0;
  if (bytes === 0) {
    return { ok: false, bytes: 0, resumedFrom: 0, error: 'downloaded file is empty' };
  }

  onProgress?.({ bytes, expectedBytes: null, ratio: 1, phase: 'verifying' });
  let digest: string | undefined;
  if (sha256) {
    digest = await sha256File(partial);
    if (digest.toLowerCase() !== sha256.toLowerCase()) {
      await fsp.rm(partial, { force: true });
      return {
        ok: false,
        bytes: 0,
        resumedFrom: 0,
        error: `SHA-256 mismatch (expected ${sha256}, got ${digest})`,
      };
    }
  }

  await fsp.rename(partial, destPath);
  onProgress?.({ bytes, expectedBytes: bytes, ratio: 1, phase: 'done' });
  return { ok: true, bytes, resumedFrom: 0, sha256: digest };
}
