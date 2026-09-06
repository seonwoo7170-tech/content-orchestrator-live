import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kieQaRetryCooldownMs,
  kieQaRetryMax,
  shouldRestartKieAfterQa
} from '../worker/lib/image-executor.js';

test('KIE QA retry policy is bounded and defaults to no fixed image cooldown', () => {
  assert.equal(kieQaRetryMax({}), 3);
  assert.equal(kieQaRetryMax({ KIE_IMAGE_QA_RETRY_MAX: '4' }), 4);
  assert.equal(kieQaRetryMax({ KIE_IMAGE_QA_RETRY_MAX: '99' }), 3);
  assert.equal(kieQaRetryCooldownMs({}), 0);
  assert.equal(kieQaRetryCooldownMs({ SERIAL_IMAGE_COOLDOWN_MS: '15000' }), 15_000);
});

test('KIE QA rejection starts a fresh task only before the configured cap', () => {
  const qaError = new Error('API_HUB_502:IMAGE_QA_REJECTED');
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 1, provider_task_id: 'task-1' }, qaError, {}), true);
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 2, provider_task_id: 'task-2' }, qaError, {}), true);
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 3, provider_task_id: 'task-3' }, qaError, {}), false);
});

test('existing task without backfilled count is treated as the first paid KIE attempt', () => {
  const qaError = new Error('IMAGE_QA_REJECTED');
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 0, provider_task_id: 'legacy-task' }, qaError, { KIE_IMAGE_QA_RETRY_MAX: '2' }), true);
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 0, provider_task_id: '' }, qaError, { KIE_IMAGE_QA_RETRY_MAX: '1' }), true);
});

test('non-QA provider failures do not spend an extra KIE retry', () => {
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 1, provider_task_id: 'task-1' }, new Error('KIE_RATE_LIMITED'), {}), false);
  assert.equal(shouldRestartKieAfterQa({ provider_attempt_count: 1, provider_task_id: 'task-1' }, new Error('KIE_PROVIDER_ERROR'), {}), false);
});
