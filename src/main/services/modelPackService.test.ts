import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadModelPack, modelPackStatus, sha256File } from './modelPackService.ts';

/**
 * The downloader is exercised against a local server: resume, restart and the
 * hash gate are the three ways a 1 GB fetch goes wrong, and none of them can be
 * checked by a pure function alone.
 */

const PAYLOAD = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

type Server = {
  url: string;
  requests: Array<{ range?: string }>;
  close: () => Promise<void>;
};

async function serve(
  opts: { honourRange?: boolean; body?: Buffer; shaOnHeaders?: boolean } = {},
): Promise<Server> {
  const body = opts.body ?? PAYLOAD;
  const requests: Array<{ range?: string }> = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    requests.push({ range: typeof range === 'string' ? range : undefined });
    if (opts.honourRange !== false && typeof range === 'string') {
      const match = /^bytes=(\d+)-$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
        'content-length': String(body.length - start),
      });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/model.gguf`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'osmos-pack-'));
}

test('a fresh download is written, verified and reported done', async () => {
  const server = await serve();
  const dir = tmpDir();
  const dest = path.join(dir, 'models', 'model.gguf');
  const phases: string[] = [];
  try {
    const result = await downloadModelPack({
      url: server.url,
      destPath: dest,
      sha256: PAYLOAD_SHA,
      expectedBytes: PAYLOAD.length,
      onProgress: (progress) => phases.push(progress.phase),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(fs.readFileSync(dest).length, PAYLOAD.length);
    assert.equal(await sha256File(dest), PAYLOAD_SHA);
    assert.equal(fs.existsSync(`${dest}.partial`), false);
    assert.ok(phases.includes('done'));
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a partial file resumes with a Range request', async () => {
  const server = await serve();
  const dir = tmpDir();
  const dest = path.join(dir, 'model.gguf');
  const partial = `${dest}.partial`;
  const half = Math.floor(PAYLOAD.length / 2);
  fs.writeFileSync(partial, PAYLOAD.subarray(0, half));
  try {
    const result = await downloadModelPack({
      url: server.url,
      destPath: dest,
      sha256: PAYLOAD_SHA,
      expectedBytes: PAYLOAD.length,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resumedFrom, half);
    assert.equal(server.requests[0]?.range, `bytes=${half}-`);
    assert.equal(await sha256File(dest), PAYLOAD_SHA);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a server that ignores Range restarts instead of appending', async () => {
  const server = await serve({ honourRange: false });
  const dir = tmpDir();
  const dest = path.join(dir, 'model.gguf');
  fs.writeFileSync(`${dest}.partial`, PAYLOAD.subarray(0, 1000));
  try {
    const result = await downloadModelPack({
      url: server.url,
      destPath: dest,
      sha256: PAYLOAD_SHA,
      expectedBytes: PAYLOAD.length,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(await sha256File(dest), PAYLOAD_SHA);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hash mismatch deletes the download and leaves no model', async () => {
  const server = await serve();
  const dir = tmpDir();
  const dest = path.join(dir, 'model.gguf');
  try {
    const result = await downloadModelPack({
      url: server.url,
      destPath: dest,
      sha256: 'deadbeef'.repeat(8),
      expectedBytes: PAYLOAD.length,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /SHA-256 mismatch/);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.partial`), false);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an HTTP error is reported without touching the partial file', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'model.gguf');
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const result = await downloadModelPack({
      url: `http://127.0.0.1:${port}/missing.gguf`,
      destPath: dest,
      expectedBytes: PAYLOAD.length,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /HTTP 404/);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status reads the manifest and reports a partial pack', () => {
  const root = tmpDir();
  try {
    fs.writeFileSync(
      path.join(root, 'model.json'),
      JSON.stringify({ id: 'osmos-fast', label: 'x', file: 'models/m.gguf', bytes: 100, sha256: 'a'.repeat(64) }),
    );
    fs.mkdirSync(path.join(root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'm.gguf.partial'), Buffer.alloc(40));

    const partial = modelPackStatus(root);
    assert.equal(partial.state, 'partial');
    assert.equal(partial.bytes, 40);
    assert.equal(partial.expectedBytes, 100);
    assert.equal(partial.verifiable, true);

    fs.writeFileSync(path.join(root, 'models', 'm.gguf'), Buffer.alloc(100));
    const installed = modelPackStatus(root);
    assert.equal(installed.state, 'installed');
    assert.equal(installed.sizeMismatch, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
