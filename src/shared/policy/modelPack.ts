/**
 * Bundled-model pack — Architecture v2 §15 and Phase 7.
 *
 * The full installer ships the GGUF weights; the lite installer ships only the
 * llama-server runtime and downloads the weights on request. Both sides need the
 * same answers to "is the pack present?", "where does a resumed download start?"
 * and "does this file match the manifest?", so those decisions live here as pure
 * functions and are unit-tested; the HTTP/crypto half is in
 * `src/main/services/modelPack.ts`.
 */

export type ModelPackManifest = {
  /** Stable pack id (`osmos-fast`). */
  id: string;
  label: string;
  /** Path inside the pack root, e.g. `models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`. */
  file: string;
  /** Where a lite install fetches it from. */
  url?: string;
  /** Lowercase hex SHA-256 of the GGUF. */
  sha256?: string;
  bytes?: number;
  license?: string;
  source?: string;
};

export type PackState = 'installed' | 'partial' | 'missing';

export type PackStatus = {
  state: PackState;
  /** Bytes already on disk (0 when missing). */
  bytes: number;
  expectedBytes: number | null;
  /** An installed file whose size disagrees with the manifest is still installed
   *  but flagged, so the UI can offer a re-download instead of failing later. */
  sizeMismatch: boolean;
  resumable: boolean;
  verifiable: boolean;
};

/**
 * Decide the pack state from what is on disk.
 *
 * `expectedBytes` may be unknown (old manifests): a present file then counts as
 * installed without a size check, and `verifiable` says whether a hash exists.
 */
export function packStatus(input: {
  fileBytes: number | null;
  partialBytes: number | null;
  expectedBytes?: number | null;
  hasSha256: boolean;
}): PackStatus {
  const expectedBytes = input.expectedBytes ?? null;
  const fileBytes = input.fileBytes ?? 0;
  const partialBytes = input.partialBytes ?? 0;

  if (fileBytes > 0) {
    return {
      state: 'installed',
      bytes: fileBytes,
      expectedBytes,
      sizeMismatch: expectedBytes !== null && expectedBytes !== fileBytes,
      resumable: false,
      verifiable: input.hasSha256,
    };
  }
  if (partialBytes > 0) {
    return {
      state: 'partial',
      bytes: partialBytes,
      expectedBytes,
      sizeMismatch: false,
      resumable: true,
      verifiable: input.hasSha256,
    };
  }
  return {
    state: 'missing',
    bytes: 0,
    expectedBytes,
    sizeMismatch: false,
    resumable: false,
    verifiable: input.hasSha256,
  };
}

/** `Content-Range: bytes 100-999/1000` → `{ start: 100, end: 999, total: 1000 }`. */
export function parseContentRange(header: string | null): {
  start: number;
  end: number;
  total: number | null;
} | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const total = match[3] === '*' ? null : Number(match[3]);
  return { start, end, total: total !== null && Number.isFinite(total) ? total : null };
}

/**
 * Where a download should start.
 *
 * A server that ignores `Range` answers `200` with the whole body: the caller must
 * truncate the partial file and start over rather than appending a full copy onto
 * a fragment.
 */
export function resumePlan(input: {
  partialBytes: number;
  status: number;
  contentRange: string | null;
  expectedBytes?: number | null;
}): { start: number; mode: 'resume' | 'restart' | 'complete' } {
  const expected = input.expectedBytes ?? null;
  if (expected !== null && input.partialBytes === expected) {
    return { start: input.partialBytes, mode: 'complete' };
  }
  if (input.partialBytes <= 0) return { start: 0, mode: 'restart' };
  if (input.status === 206) {
    const range = parseContentRange(input.contentRange);
    if (range && range.start === input.partialBytes) {
      return { start: input.partialBytes, mode: 'resume' };
    }
  }
  return { start: 0, mode: 'restart' };
}

/** Human size for the Settings row; keeps one decimal below 10 units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Progress ratio in 0..1 for a UI bar; 0 when the total is unknown. */
export function downloadRatio(bytes: number, expectedBytes: number | null): number {
  if (!expectedBytes || expectedBytes <= 0) return 0;
  return Math.max(0, Math.min(1, bytes / expectedBytes));
}
