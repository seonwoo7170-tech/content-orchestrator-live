import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkersAiFailure } from '../src/lib/cloudflare-ai.js';

test('nested Workers AI provider code is classified without exposing raw provider text', () => {
  const cause = new Error('opaque binding error');
  cause.error = {
    details: {
      errors: [{ code: 3036, message: 'sensitive provider detail that must not be returned' }]
    }
  };

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_ACCOUNT_LIMITED',
    status: 429,
    providerCode: 3036
  });
});

test('nested HTTP 429 is safely classified as generic rate limiting', () => {
  const cause = new Error('opaque binding error');
  cause.response = { status: 429, data: { message: 'private upstream text' } };

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_RATE_LIMITED',
    status: 429,
    providerCode: null
  });
});

test('known provider code embedded only in a nested stack is still safely recognized', () => {
  const cause = new Error('opaque');
  cause.cause = { stack: 'Inference failed internally (3040) with private context' };

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_OUT_OF_CAPACITY',
    status: 429,
    providerCode: 3040
  });
});

test('FLUX content-filter code in a nested string is recognized without returning provider text', () => {
  const cause = new Error('opaque');
  cause.error = 'AiError: 3030: Input prompt contains NSFW content with additional private provider context';

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_CONTENT_FILTERED',
    status: 400,
    providerCode: 3030
  });
});

test('5006 exposes only safe schema requirements and not raw provider context', () => {
  const cause = new Error('opaque');
  cause.error = "AiError: 5006: Error: oneOf at '/' not met, required properties at '/' are 'multipart', Type mismatch of '/prompt', private-secret=never-return-this";

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_BAD_INPUT',
    status: 400,
    providerCode: 5006,
    validationHint: 'required:/:multipart;type-mismatch:/prompt;schema-choice:/'
  });
});

test('5006 schema hints reject unsafe characters from provider text', () => {
  const cause = new Error('opaque');
  cause.error = "AiError 5006 required properties at '/' are 'prompt,$SECRET'";

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_BAD_INPUT',
    status: 400,
    providerCode: 5006
  });
});

test('unknown numeric provider code is exposed only as a safe number', () => {
  const cause = new Error('opaque');
  cause.error = 'AiError: 3999: private provider detail';

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_PROVIDER_REJECTED',
    status: 502,
    providerCode: 3999
  });
});

test('unknown nested upstream 5xx remains redacted and generic', () => {
  const cause = new Error('do not expose this upstream body');
  cause.error = { response: { statusCode: 503, data: { secret: 'hidden' } } };

  assert.deepEqual(classifyWorkersAiFailure(cause), {
    message: 'CLOUDFLARE_AI_UPSTREAM_FAILED',
    status: 502,
    providerCode: null
  });
});
