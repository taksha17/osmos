import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BYTES,
  ollamaImages,
  openAiContentParts,
  openAiMessagesWithImages,
  providerAcceptsVision,
  resolveImage,
  toDataUrl,
} from './vision.ts';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeReader(content: string) {
  const calls: string[] = [];
  const readFile = (path: string) => {
    calls.push(path);
    return Buffer.from(content);
  };
  return { readFile, calls };
}

test('text-only content stays a plain string', () => {
  assert.equal(openAiContentParts('what is a mutex?', []), 'what is a mutex?');
  const messages = openAiMessagesWithImages([{ role: 'user', content: 'hi' }], []);
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
});

test('an image becomes a content part next to the text', () => {
  const parts = openAiContentParts('what is wrong?', [
    { mime: 'image/png', base64: PNG_BASE64, bytes: 100 },
  ]);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: 'text', text: 'what is wrong?' });
  assert.deepEqual(parts[1], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
  });
});

test('images attach to the last user turn only', () => {
  const messages = openAiMessagesWithImages(
    [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'look at this' },
    ],
    [{ mime: 'image/png', base64: PNG_BASE64, bytes: 100 }],
  );
  assert.equal(messages[0]!.content, 'first');
  assert.equal(messages[1]!.content, 'answer');
  assert.ok(Array.isArray(messages[2]!.content));
});

test('ollama gets bare base64 strings', () => {
  assert.deepEqual(ollamaImages([{ mime: 'image/png', base64: PNG_BASE64, bytes: 100 }]), [
    PNG_BASE64,
  ]);
  assert.deepEqual(ollamaImages([]), []);
});

test('a data URL resolves without touching the reader', () => {
  const { readFile, calls } = fakeReader('unused');
  const image = resolveImage({ mime: '', dataRef: `data:image/jpeg;base64,${PNG_BASE64}` }, readFile);
  assert.equal(image.mime, 'image/jpeg');
  assert.equal(image.base64, PNG_BASE64);
  assert.deepEqual(calls, []);
  assert.equal(toDataUrl(image), `data:image/jpeg;base64,${PNG_BASE64}`);
});

test('a file reference is read and encoded', () => {
  const { readFile, calls } = fakeReader('raw-bytes');
  const image = resolveImage({ mime: 'image/png', dataRef: 'C:/tmp/shot.png' }, readFile);
  assert.equal(image.base64, Buffer.from('raw-bytes').toString('base64'));
  assert.deepEqual(calls, ['C:/tmp/shot.png']);
});

test('bad references, mimes and oversized images are rejected', () => {
  const { readFile } = fakeReader('x');
  assert.throws(() => resolveImage({ mime: 'image/png', dataRef: '  ' }, readFile), /no dataRef/);
  assert.throws(
    () => resolveImage({ mime: 'application/pdf', dataRef: `data:application/pdf;base64,${PNG_BASE64}` }, readFile),
    /unsupported image type/,
  );
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
  assert.throws(
    () => resolveImage({ mime: 'image/png', dataRef: `data:image/png;base64,${huge}` }, readFile),
    /limit/,
  );
});

test('vision capability follows the model, not just the provider', () => {
  assert.equal(providerAcceptsVision({ id: 'openai', model: 'gpt-4o' }), true);
  assert.equal(providerAcceptsVision({ id: 'openai', model: 'gpt-3.5-turbo' }), false);
  assert.equal(providerAcceptsVision({ id: 'ollama', model: 'llava:13b' }), true);
  assert.equal(providerAcceptsVision({ id: 'ollama', model: 'qwen2.5:1.5b' }), false);
  assert.equal(providerAcceptsVision({ id: 'openrouter', model: 'anthropic/claude-3.5-sonnet' }), false);
  assert.equal(providerAcceptsVision({ id: 'openrouter', model: 'qwen/qwen2.5-vl-72b' }), true);
  assert.equal(providerAcceptsVision({ id: 'groq', model: 'llama-3.2-vision' }), true);
  assert.equal(providerAcceptsVision({ id: 'searxng', model: 'gpt-4o' }), false);
});

test('NVIDIA uses an explicit vision model when configured', () => {
  assert.equal(
    providerAcceptsVision({ id: 'nvidia', model: 'nvidia/nemotron-3.5-bolt-e4b' }),
    false,
  );
  assert.equal(
    providerAcceptsVision({
      id: 'nvidia',
      model: 'nvidia/nemotron-3.5-bolt-e4b',
      visionModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    }),
    true,
  );
  assert.equal(
    providerAcceptsVision({ id: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' }),
    true,
  );
});
