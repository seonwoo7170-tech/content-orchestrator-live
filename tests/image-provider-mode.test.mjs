import test from 'node:test';
import assert from 'node:assert/strict';
import { imageProviderMode, imageProviderSequence, imageStagePacingMs } from '../worker/lib/image-executor.js';
import { modelScopeAlreadyAttempted, scheduledProviderModeForImage } from '../worker/lib/image-executor-resilient.js';

test('automatic image routing is always the default', () => {
  assert.equal(imageProviderMode({}), 'auto');
  assert.equal(imageProviderMode({ KIE_IMAGE_FALLBACK_ENABLED: 'true' }), 'auto');
  assert.equal(imageProviderMode({ KIE_IMAGE_FALLBACK_ENABLED: 'false' }), 'auto');
});

test('base automatic image routing remains compatible for direct callers', () => {
  assert.deepEqual(imageProviderSequence('auto'), ['puter', 'kie', 'cloudflare']);
  assert.deepEqual(imageProviderSequence('puter'), ['puter']);
  assert.deepEqual(imageProviderSequence('kie'), ['kie']);
  assert.deepEqual(imageProviderSequence('cloudflare'), ['cloudflare']);
});

test('scheduled routing uses Puter once, then synchronous Cloudflare before creating a KIE task', () => {
  const env = { PUTER_AUTH_TOKEN: 'test-secret', KIE_IMAGE_GENERATION_RETRY_MAX: '3', MODELSCOPE_IMAGE_ENABLED: 'false' };
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 0, provider_attempt_count: 0 }, env), 'puter');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1, provider_attempt_count: 0 }, env), 'cloudflare');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1, provider_attempt_count: 2 }, env), 'cloudflare');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1, provider_attempt_count: 3 }, env), 'cloudflare');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1, provider: 'kie-ai', provider_task_id: 'kie-task', provider_status: 'generating' }, env), 'kie');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1, provider: 'puter', provider_task_id: 'puterfs:~/checkpoint.png', provider_status: 'outcome_unknown' }, env), 'puter');
});

test('scheduled routing keeps optional ModelScope ahead of Cloudflare when explicitly enabled', () => {
  const env = { MODELSCOPE_IMAGE_ENABLED: 'true' };
  assert.equal(scheduledProviderModeForImage({ provider_attempt_count: 0, puter_attempted: 1 }, env), 'modelscope');
  assert.equal(scheduledProviderModeForImage({ provider: 'kie-ai', provider_attempt_count: 4, puter_attempted: 1 }, env), 'modelscope');
  assert.equal(scheduledProviderModeForImage({ provider: 'modelscope', provider_attempt_count: 1, puter_attempted: 1 }, env), 'cloudflare');
  assert.equal(modelScopeAlreadyAttempted({ provider: 'cloudflare', provider_attempt_count: 4, provider_error_code: 'IMAGE_FALLBACK_FAILED:MODELSCOPE_ATTEMPTED:CLOUDFLARE_AI_ACCOUNT_LIMITED' }), true);
});

test('explicit provider mode is respected without inspecting provider secrets in the orchestrator', () => {
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'cloudflare' }), 'cloudflare');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'auto' }), 'auto');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'puter' }), 'puter');
  assert.equal(imageProviderMode({ IMAGE_PROVIDER_MODE: 'kie' }), 'kie');
  assert.throws(() => imageProviderMode({ IMAGE_PROVIDER_MODE: 'unknown' }), /IMAGE_PROVIDER_MODE_INVALID/);
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1 }, { IMAGE_PROVIDER_MODE: 'kie' }), 'kie');
  assert.equal(scheduledProviderModeForImage({ puter_attempted: 1 }, { IMAGE_PROVIDER_MODE: 'cloudflare' }), 'cloudflare');
});

test('image pacing is limited to the requested 3-5 second safety window', () => {
  assert.equal(imageStagePacingMs({}), 0);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '4000' }), 4000);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '1000' }), 3000);
  assert.equal(imageStagePacingMs({ IMAGE_STAGE_PACING_MS: '9000' }), 5000);
});
