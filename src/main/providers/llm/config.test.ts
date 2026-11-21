/**
 * Wire-level proof for the vision path (§6.4).
 *
 * `vision.test.ts` checks the payload builders in isolation; this file drives the
 * real adapter the chat path uses (`llmProviderFromConfig` → `streamWithProvider`)
 * with `fetch` stubbed, and asserts what would actually go over the network: an
 * image on an OpenAI-compatible request as an `image_url` part, an image on an
 * Ollama request in the message `images` array, and a text-only request unchanged
 * as a plain string.
 *
 * No key and no network: the stub records the request and replays a canned stream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../../../shared/types.js';
import type { LlmStreamRequest } from '../../../shared/contracts/llm.js';
import { llmProviderFromConfig } from './config.js';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE = { mime: 'image/png', dataRef: `data:image/png;base64,${PNG}` };

const OPENAI: ProviderConfig = {
  id: 'openai',
  label: 'OpenAI',
  apiKey: 'test-key',
  baseUrl: 'https://api.test/v1',
  model: 'gpt-4o',
};

const OLLAMA: ProviderConfig = {
  id: 'ollama',
  label: 'Ollama',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llava:13b',
};

const SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n';
const NDJSON = '{"message":{"content":"ok"},"done":false}\n{"message":{"content":""},"done":true}\n';

type Recorded = { url: string; body: any };

async function withStubbedFetch(
  reply: string,
  run: (calls: Recorded[]) => Promise<void>,
): Promise<void> {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(reply, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function drain(provider: ProviderConfig, req: LlmStreamRequest): Promise<string[]> {
  const text: string[] = [];
  for await (const chunk of llmProviderFromConfig(provider).stream(req)) {
    if (chunk.kind === 'delta') text.push(chunk.text);
  }
  return text;
}

function lastMessage(body: any): any {
  return body.messages[body.messages.length - 1];
}

test('an OpenAI-compatible request carries the image as a content part', async () => {
  await withStubbedFetch(SSE, async (calls) => {
    const text = await drain(OPENAI, {
      system: 'you are osmos',
      messages: [{ role: 'user', content: 'why does this fail?' }],
      images: [IMAGE],
    });
    assert.deepEqual(text, ['ok']);

    const call = calls[0]!;
    assert.match(call.url, /\/chat\/completions$/);
    assert.equal(call.body.model, 'gpt-4o');
    assert.equal(call.body.messages[0].role, 'system');
    assert.equal(call.body.messages[0].content, 'you are osmos');

    const last = lastMessage(call.body);
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content), 'content must become a part list');
    assert.deepEqual(last.content[0], { type: 'text', text: 'why does this fail?' });
    assert.deepEqual(last.content[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG}` },
    });
  });
});

test('an Ollama request carries base64 in the message images array', async () => {
  await withStubbedFetch(NDJSON, async (calls) => {
    const text = await drain(OLLAMA, {
      system: 'you are osmos',
      messages: [{ role: 'user', content: 'why does this fail?' }],
      images: [IMAGE],
    });
    assert.deepEqual(text, ['ok']);

    const call = calls[0]!;
    assert.match(call.url, /\/api\/chat$/);
    const last = lastMessage(call.body);
    assert.equal(last.content, 'why does this fail?', 'Ollama keeps content a string');
    assert.deepEqual(last.images, [PNG]);
  });
});

test('a text-only request stays a plain string on both providers', async () => {
  await withStubbedFetch(SSE, async (calls) => {
    await drain(OPENAI, {
      system: 'sys',
      messages: [{ role: 'user', content: 'what is a mutex?' }],
    });
    const last = lastMessage(calls[0]!.body);
    assert.equal(last.content, 'what is a mutex?');
    assert.equal(typeof last.content, 'string');
  });

  await withStubbedFetch(NDJSON, async (calls) => {
    await drain(OLLAMA, {
      system: 'sys',
      messages: [{ role: 'user', content: 'what is a mutex?' }],
    });
    const last = lastMessage(calls[0]!.body);
    assert.equal(last.content, 'what is a mutex?');
    assert.equal(last.images, undefined);
  });
});

test('an image is refused before any request when the model has no vision', async () => {
  const textOnly: ProviderConfig = { ...OPENAI, model: 'gpt-3.5-turbo' };
  await withStubbedFetch(SSE, async (calls) => {
    await assert.rejects(
      async () =>
        drain(textOnly, {
          system: 'sys',
          messages: [{ role: 'user', content: 'look' }],
          images: [IMAGE],
        }),
      /no vision support/,
    );
    assert.equal(calls.length, 0, 'no request may leave for a lane without vision');
    assert.equal(llmProviderFromConfig(textOnly).capabilities.vision, false);
    assert.equal(llmProviderFromConfig(OPENAI).capabilities.vision, true);
  });
});

test('a file path reference is resolved to base64 on the wire', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  // Tests are bundled into .test-build, so resolve the fixture from the repo root.
  const fixture = path.join(process.cwd(), 'src', 'main', 'providers', 'llm', 'fixtures', 'one-pixel.png');
  assert.ok(fs.existsSync(fixture), 'fixture image is committed next to this test');

  await withStubbedFetch(SSE, async (calls) => {
    await drain(OPENAI, {
      system: 'sys',
      messages: [{ role: 'user', content: 'look' }],
      images: [{ mime: 'image/png', dataRef: fixture }],
    });
    const part = lastMessage(calls[0]!.body).content[1];
    assert.equal(part.type, 'image_url');
    assert.match(part.image_url.url, /^data:image\/png;base64,/);
    assert.ok(part.image_url.url.length > 'data:image/png;base64,'.length);
  });
});
