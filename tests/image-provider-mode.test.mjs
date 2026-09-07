import test from 'node:test';
import assert from 'node:assert/strict';
import { imageProviderMode, imageProviderSequence, imageStagePacingMs } from '../worker/lib/image-executor.js';

test('automatic image routing is always the default', () => {
  assert.equal(imageProviderMode({}), 'auto');
  assert.equal(imageProviderMode({ KIE_IMAGE_FALLBACK_ENABLED: 'true' }), 'auto');
  assert.equal(imageProviderMode({ KIE_IMAGE_FALLBACK_ENABLED: 'false' }), 'auto');
});

test('automatic image routing is KIE first, ModelScope second, then Cloudflare', () => {
  assert.deepEqual(imageProviderSequence('auto'), ['kie', 'modelscope', 'cloudflare']);
  assert.deepEqual(imageProviderSequence('kie'), ['kie']);
  assert.deepEqual(imageProviderSequence('modelscope'), ['modelscope']);
  assert.deepEqual(imageProviderSequence('cloudflare'), ['cloudflare']);
});

test('explicit provider mode is respected without inspecting provider secrets in the orchestrator', () => {
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'cloudflare' }), 'cloudflare');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'auto' }), 'auto');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'kie' }), 'kie');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'modelscope' }), 'modelscope');
  assert.throws(() => imageProviderMode({ IMAGE_PROVIDER_MODE: 'unknown' }), /IMAGE_PROVIDER_MODE_INVALID/);
});

test('image pacing is limited to the requested 3-5 second safety window', () => {
  assert.equal(imageStagePacingMs({}), 0);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '4000' }), 4000);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '1000' }), 3000);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '9000' }), 5000);
});