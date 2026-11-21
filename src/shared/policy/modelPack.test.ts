import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadRatio,
  formatBytes,
  packStatus,
  parseContentRange,
  resumePlan,
} from './modelPack.ts';

test('a present file is installed, and a size mismatch is visible', () => {
  const ok = packStatus({ fileBytes: 100, partialBytes: 0, expectedBytes: 100, hasSha256: true });
  assert.equal(ok.state, 'installed');
  assert.equal(ok.sizeMismatch, false);
  assert.equal(ok.verifiable, true);

  const short = packStatus({ fileBytes: 62, partialBytes: 0, expectedBytes: 100, hasSha256: true });
  assert.equal(short.state, 'installed');
  assert.equal(short.sizeMismatch, true);
});

test('a partial file resumes; nothing on disk is missing', () => {
  const partial = packStatus({ fileBytes: 0, partialBytes: 40, expectedBytes: 100, hasSha256: false });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.resumable, true);
  assert.equal(partial.bytes, 40);
  assert.equal(partial.verifiable, false);

  const missing = packStatus({ fileBytes: null, partialBytes: null, expectedBytes: 100, hasSha256: false });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.bytes, 0);
});

test('a manifest without a size still reports installed', () => {
  const status = packStatus({ fileBytes: 10, partialBytes: 0, expectedBytes: null, hasSha256: false });
  assert.equal(status.state, 'installed');
  assert.equal(status.expectedBytes, null);
  assert.equal(status.sizeMismatch, false);
});

test('Content-Range is parsed or rejected, never guessed', () => {
  assert.deepEqual(parseContentRange('bytes 100-999/1000'), { start: 100, end: 999, total: 1000 });
  assert.deepEqual(parseContentRange('bytes 0-0/*'), { start: 0, end: 0, total: null });
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange('bytes 9-1/10'), null);
  assert.equal(parseContentRange('items 1-2/3'), null);
});

test('a ranged response continues the partial file', () => {
  const plan = resumePlan({
    partialBytes: 100,
    status: 206,
    contentRange: 'bytes 100-999/1000',
    expectedBytes: 1000,
  });
  assert.deepEqual(plan, { start: 100, mode: 'resume' });
});

test('a server that ignores Range restarts instead of appending', () => {
  const plan = resumePlan({ partialBytes: 100, status: 200, contentRange: null, expectedBytes: 1000 });
  assert.deepEqual(plan, { start: 0, mode: 'restart' });
});

test('a partial file that already matches the expected size is complete', () => {
  const plan = resumePlan({ partialBytes: 1000, status: 416, contentRange: null, expectedBytes: 1000 });
  assert.deepEqual(plan, { start: 1000, mode: 'complete' });
});

test('byte counts are formatted for a settings row', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(986 * 1024 * 1024), '986 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB');
});

test('progress ratio is clamped and safe without a total', () => {
  assert.equal(downloadRatio(50, 100), 0.5);
  assert.equal(downloadRatio(150, 100), 1);
  assert.equal(downloadRatio(50, null), 0);
  assert.equal(downloadRatio(50, 0), 0);
});
