import test from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorDetail, safeImageErrorCodes } from '../worker/lib/image-diagnostics.js';

test('image diagnostics exposes only allowlisted provider error codes from a failed chain', () => {
  assert.deepEqual(
    safeImageErrorCodes('IMAGE_PROVIDER_CHAIN_FAILED:KIE_RATE_LIMITED:WORKERS_AI_ACCOUNT_LIMIT'),
    ['IMAGE_PROVIDER_CHAIN_FAILED', 'KIE_RATE_LIMITED', 'WORKERS_AI_ACCOUNT_LIMIT']
  );
});

test('image diagnostics drops arbitrary provider text while preserving safe codes', () => {
  assert.deepEqual(
    safeImageErrorCodes('IMAGE_PROVIDER_CHAIN_FAILED:secret-token=abc:KIE_AUTH_FAILED:some provider detail'),
    ['IMAGE_PROVIDER_CHAIN_FAILED', 'KIE_AUTH_FAILED']
  );
});

test('errorDetail surfaces the real provider reason that safeImageErrorCodes drops', () => {
  assert.equal(
    safeErrorDetail('IMAGE_PROVIDER_CHAIN_RETRY:API_HUB_422:KIE_VALIDATION_FAILED:invalid aspect_ratio value'),
    'IMAGE_PROVIDER_CHAIN_RETRY:API_HUB_422:KIE_VALIDATION_FAILED:invalid aspect_ratio value'
  );
});

test('errorDetail is bounded and drops characters outside the safe charset', () => {
  assert.equal(safeErrorDetail('reason with "quotes" and {braces} and a very long tail'.repeat(10)).length <= 300, true);
  assert.equal(safeErrorDetail(null), null);
  assert.equal(safeErrorDetail(''), null);
});
