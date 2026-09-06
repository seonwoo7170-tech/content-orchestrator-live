import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyFailureCode,
  decideJobRecovery,
  isDailySlotRecoveryEligible,
  safeFailureCode
} from '../worker/lib/job-recovery.js';

const recoverySource = fs.readFileSync(new URL('../worker/lib/job-recovery.js', import.meta.url), 'utf8');

test('failure codes are reduced to a safe first token without provider text', () => {
  assert.equal(safeFailureCode('FETCH_FAILED: upstream secret payload'), 'FETCH_FAILED');
  assert.equal(safeFailureCode({ code: 'rate-limit', message: 'private provider text' }), 'RATE_LIMIT');
});

test('temporary provider failures retry quickly on the first failure', () => {
  const decision = decideJobRecovery({
    error: 'FETCH_FAILED',
    retryCount: 0,
    now: '2026-08-31T00:00:00.000Z'
  });
  assert.equal(decision.classification, 'transient');
  assert.equal(decision.recoveryState, 'retry_wait');
  assert.equal(decision.retryCount, 1);
  assert.equal(decision.delayMinutes, 1);
  assert.equal(decision.nextRetryAt, '2026-08-31T00:01:00.000Z');
});

test('API Hub route mismatch codes are bounded transient failures after fallback support', () => {
  for (const code of ['API_HUB_404', 'API_HUB_405']) {
    const decision = decideJobRecovery({ error: code, retryCount: 0, now: '2026-08-31T00:00:00.000Z' });
    assert.equal(decision.classification, 'transient');
    assert.equal(decision.recoveryState, 'retry_wait');
    assert.equal(decision.retryCount, 1);
  }
});

test('API Hub throttling uses the short bounded retry ladder', () => {
  const decision = decideJobRecovery({ error: 'API_HUB_429', retryCount: 0, now: '2026-08-31T00:00:00.000Z' });
  assert.equal(decision.classification, 'transient');
  assert.equal(decision.recoveryState, 'retry_wait');
  assert.equal(decision.retryCount, 1);
  assert.equal(decision.delayMinutes, 1);
  assert.equal(decision.nextRetryAt, '2026-08-31T00:01:00.000Z');
});

test('malformed model JSON is retryable but bounded', () => {
  assert.equal(classifyFailureCode('CRITIC_JSON_INVALID').classification, 'transient');
  const decision = decideJobRecovery({
    error: 'CRITIC_JSON_INVALID',
    retryCount: 1,
    now: '2026-08-31T00:00:00.000Z'
  });
  assert.equal(decision.recoveryState, 'retry_wait');
  assert.equal(decision.retryCount, 2);
  assert.equal(decision.delayMinutes, 3);
});

test('daily quota exhaustion uses a slower but bounded retry schedule', () => {
  const decision = decideJobRecovery({
    error: 'RESOURCE_EXHAUSTED',
    retryCount: 0,
    now: '2026-08-31T00:00:00.000Z'
  });
  assert.equal(decision.classification, 'quota');
  assert.equal(decision.recoveryState, 'retry_wait');
  assert.equal(decision.delayMinutes, 30);
  assert.equal(decision.nextRetryAt, '2026-08-31T00:30:00.000Z');
});

test('authorization and credit failures remain held', () => {
  for (const code of [
    'KIE_INSUFFICIENT_CREDITS',
    'KIE_AUTH_FAILED',
    'GOOGLE_OAUTH_NOT_CONFIGURED'
  ]) {
    const decision = decideJobRecovery({ error: code, retryCount: 0, now: '2026-08-31T00:00:00.000Z' });
    assert.equal(decision.recoveryState, 'held');
    assert.equal(decision.retryCount, 0);
    assert.equal(decision.nextRetryAt, null);
    assert.equal(decision.holdReason, code);
  }
});

test('image generation and completion failures retry quickly before the bounded cap', () => {
  for (const code of [
    'AUTO_WORK_IMAGE_GENERATION_FAILED',
    'AUTO_WORK_IMAGES_UNRESOLVED',
    'AUTO_WORK_THUMBNAIL_MISSING'
  ]) {
    const decision = decideJobRecovery({ error: code, retryCount: 0, now: '2026-08-31T00:00:00.000Z' });
    assert.equal(decision.classification, 'image_transient');
    assert.equal(decision.recoveryState, 'retry_wait');
    assert.equal(decision.retryCount, 1);
    assert.equal(decision.delayMinutes, 1);
    assert.equal(decision.nextRetryAt, '2026-08-31T00:01:00.000Z');
    assert.equal(decision.holdReason, null);
  }
});

test('unknown failures fail closed into held state', () => {
  const decision = decideJobRecovery({ error: 'SOMETHING_UNCLASSIFIED', retryCount: 0 });
  assert.equal(decision.classification, 'held');
  assert.equal(decision.recoveryState, 'held');
});

test('retryable failures stop automatically at the retry cap', () => {
  const decision = decideJobRecovery({ error: 'FETCH_FAILED', retryCount: 3 });
  assert.equal(decision.recoveryState, 'held');
  assert.equal(decision.retryCount, 3);
  assert.equal(decision.holdReason, 'RETRY_LIMIT_REACHED');
});

test('daily slots run only when recovery state is clear, due, or a legacy route hold is safely recoverable', () => {
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'none' }, '2026-08-31T01:00:00Z'), true);
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'held' }, '2026-08-31T01:00:00Z'), false);
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'held', retry_count: 1, last_error_code: 'API_HUB_404' }, '2026-08-31T01:00:00Z'), true);
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'held', retry_count: 0, last_error_code: 'KIE_AUTH_FAILED' }, '2026-08-31T01:00:00Z'), false);
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'retry_wait', next_retry_at: '2026-08-31T01:05:00Z' }, '2026-08-31T01:00:00Z'), false);
  assert.equal(isDailySlotRecoveryEligible({ status: 'pending', recovery_state: 'retry_wait', next_retry_at: '2026-08-31T00:55:00Z' }, '2026-08-31T01:00:00Z'), true);
});

test('recovery query self-heals recent failed jobs with no recovery registration and stale route holds', () => {
  assert.match(recoverySource, /recovery_state = 'none' AND updated_at >= datetime\('now', '-1 day'\)/);
  assert.match(recoverySource, /last_error_code IN \('API_HUB_404', 'API_HUB_405'\)/);
  assert.match(recoverySource, /state === 'held'/);
  assert.match(recoverySource, /state === 'retry_wait'/);
});
