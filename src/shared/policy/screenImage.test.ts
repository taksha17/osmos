import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREEN_IMAGE_MAX_AGE_MS,
  SCREEN_IMAGE_MAX_SKEW_MS,
  freshScreenImage,
} from './screenImage.ts';

const GRAB = { dataRef: 'data:image/png;base64,AAAA', at: 1_000_000, mime: 'image/png' };

test('a fresh grab paired with the OCR text is attached', () => {
  const image = freshScreenImage(GRAB, 1_000_000, 1_001_000);
  assert.deepEqual(image, { mime: 'image/png', dataRef: GRAB.dataRef });
});

test('an image without its OCR timestamp is not attached', () => {
  assert.equal(freshScreenImage(GRAB, undefined, 1_000_000), null);
  assert.equal(freshScreenImage(GRAB, Number.NaN, 1_000_000), null);
});

test('a stale grab is not attached', () => {
  assert.equal(freshScreenImage(GRAB, GRAB.at, GRAB.at + SCREEN_IMAGE_MAX_AGE_MS + 1), null);
  assert.ok(freshScreenImage(GRAB, GRAB.at, GRAB.at + SCREEN_IMAGE_MAX_AGE_MS - 1));
});

test('a grab that does not match the OCR snapshot is not attached', () => {
  assert.equal(freshScreenImage(GRAB, GRAB.at + SCREEN_IMAGE_MAX_SKEW_MS + 1, GRAB.at), null);
  assert.ok(freshScreenImage(GRAB, GRAB.at - SCREEN_IMAGE_MAX_SKEW_MS + 1, GRAB.at));
});

test('empty or missing grabs are ignored', () => {
  assert.equal(freshScreenImage(null, GRAB.at, GRAB.at), null);
  assert.equal(freshScreenImage({ dataRef: '   ', at: GRAB.at }, GRAB.at, GRAB.at), null);
  assert.equal(freshScreenImage({ dataRef: GRAB.dataRef, at: Number.NaN }, GRAB.at, GRAB.at), null);
});

test('mime defaults to png and options can widen the windows', () => {
  const image = freshScreenImage(
    { dataRef: 'data:image/jpeg;base64,BBBB', at: 5_000 },
    1_000,
    60_000,
    { maxAgeMs: 120_000, maxSkewMs: 10_000 },
  );
  assert.equal(image?.mime, 'image/png');
  assert.ok(image);
});
