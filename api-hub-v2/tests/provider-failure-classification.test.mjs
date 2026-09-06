import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkersAi } from '../src/lib/cloudflare-ai.js';

function throwingBinding(cause) {
  return {
    async run() {
      throw cause;
    }
  };
}

async function captureFailure(cause) {
  try {
    await runWorkersAi({}, {
      model: '@cf/openai/gpt-oss-120b',
      prompt: 'test',
      maxTokens: 32
    }, throwingBinding(cause));
  } catch (error) {
    return error;
  }
  throw new Error('EXPECTED_FAILURE');
}

test('Workers AI daily allocation failure is safely classified without leaking provider text', async () => {
  const error = await captureFailure(new Error('provider 3036 daily free allocation exhausted secret-detail-do-not-leak'));
  assert.equal(error.message, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
  assert.equal(error.status, 429);
  assert.ok(!error.message.includes('secret-detail-do-not-leak'));
});

test('Workers AI out-of-capacity failure is safely classified', async () => {
  const cause = new Error('temporary provider problem');
  cause.code = 3040;
  const error = await captureFailure(cause);
  assert.equal(error.message, 'CLOUDFLARE_AI_OUT_OF_CAPACITY');
  assert.equal(error.status, 429);
});

test('Workers AI paid-plan failure is safely classified', async () => {
  const error = await captureFailure(new Error('5035 model requires Workers Paid'));
  assert.equal(error.message, 'CLOUDFLARE_AI_PAID_PLAN_REQUIRED');
  assert.equal(error.status, 403);
});

test('Workers AI timeout is safely classified', async () => {
  const error = await captureFailure(new Error('error code 3007 timeout'));
  assert.equal(error.message, 'CLOUDFLARE_AI_TIMEOUT');
  assert.equal(error.status, 408);
});

test('unknown Workers AI binding failure stays generic and does not leak raw provider text', async () => {
  const error = await captureFailure(new Error('unknown-sensitive-provider-detail'));
  assert.equal(error.message, 'CLOUDFLARE_AI_BINDING_FAILED');
  assert.equal(error.status, 502);
  assert.ok(!error.message.includes('unknown-sensitive-provider-detail'));
});
