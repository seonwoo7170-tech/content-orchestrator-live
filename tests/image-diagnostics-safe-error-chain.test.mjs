import test from 'node:test';
import assert from 'node:assert/strict';
import { safeImageErrorCodes } from '../worker/lib/image-diagnostics.js';

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
