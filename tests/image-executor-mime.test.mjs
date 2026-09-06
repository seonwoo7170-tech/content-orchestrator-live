import test from 'node:test';
import assert from 'node:assert/strict';
import { imageExtensionForMimeType, imageStorageKey } from '../worker/lib/image-executor.js';

test('image MIME types map to stable raster file extensions', () => {
  assert.equal(imageExtensionForMimeType('image/jpeg'), 'jpg');
  assert.equal(imageExtensionForMimeType('image/png'), 'png');
  assert.equal(imageExtensionForMimeType('image/webp'), 'webp');
  assert.equal(imageExtensionForMimeType('image/svg+xml'), 'jpg');
  assert.equal(imageExtensionForMimeType('image/jpeg; charset=binary'), 'jpg');
});

test('image storage keys preserve final output MIME', () => {
  assert.equal(imageStorageKey(42, { role: 'thumbnail', position: 0 }, 'image/png'), 'jobs/42/thumbnail-0.png');
  assert.equal(imageStorageKey(42, { role: 'body', position: 2 }, 'image/webp'), 'jobs/42/body-2.webp');
  assert.equal(imageStorageKey(42, { role: 'body', position: 1 }, 'image/jpeg'), 'jobs/42/body-1.jpg');
});
