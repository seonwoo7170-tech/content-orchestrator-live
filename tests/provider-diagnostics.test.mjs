import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseCloudflareViaHub, sanitizeDiagnosticError } from '../worker/lib/provider-diagnostics.js';

test('provider diagnostic accepts redacted OK response from Hub', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, model: '@cf/openai/gpt-oss-120b', response: 'OK' }), { status: 200 });
  const result = await diagnoseCloudflareViaHub({ API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'hub-secret' }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.response, 'OK');
});

test('provider diagnostic retries the Cloudflare probe as GET only when Hub rejects POST with 405', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, key: init.headers?.['x-hub-api-key'] });
    const pathname = new URL(url).pathname;
    const cloudflareCalls = calls.filter((call) => new URL(call.url).pathname === '/api/hub/ai/diagnostics/cloudflare');
    if (pathname === '/api/hub/ai/diagnostics/cloudflare' && cloudflareCalls.length === 1) {
      return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405 });
    }
    if (pathname === '/health') {
      return new Response(JSON.stringify({ geminiConfigured: true, freeAiConfigured: true, freeAiFallbackEnabled: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, model: '@cf/openai/gpt-oss-120b', response: 'OK' }), { status: 200 });
  };

  const result = await diagnoseCloudflareViaHub({ API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'hub-secret' }, fetchImpl);
  const diagnosticCalls = calls.filter((call) => new URL(call.url).pathname === '/api/hub/ai/diagnostics/cloudflare');

  assert.equal(result.ok, true);
  assert.deepEqual(diagnosticCalls.map((call) => call.method), ['POST', 'GET']);
  assert.deepEqual(diagnosticCalls.map((call) => call.key), ['hub-secret', 'hub-secret']);
  assert.equal(calls.filter((call) => new URL(call.url).pathname === '/health').length, 1);
});

test('diagnostic errors are redacted', () => {
  const error = new Error('API_HUB_401');
  error.status = 401;
  error.data = { leaked: 'must-not-be-returned' };
  assert.deepEqual(sanitizeDiagnosticError(error), { ok: false, code: 'API_HUB_401', status: 401, details: null });
});

test('diagnostic preserves an allowlisted Workers AI account-limit code without provider payload', () => {
  const error = new Error('API_HUB_429:CLOUDFLARE_AI_ACCOUNT_LIMITED');
  error.status = 429;
  error.data = { error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED', providerPayload: 'must-not-be-returned' };
  assert.deepEqual(sanitizeDiagnosticError(error), {
    ok: false,
    code: 'CLOUDFLARE_AI_ACCOUNT_LIMITED',
    status: 429,
    details: null
  });
});

test('diagnostic does not expose unknown provider error text', () => {
  const error = new Error('provider-secret-message');
  error.status = 502;
  error.data = { error: 'provider-secret-message', token: 'must-not-be-returned' };
  assert.deepEqual(sanitizeDiagnosticError(error), {
    ok: false,
    code: 'DIAGNOSTIC_FAILED',
    status: 502,
    details: null
  });
});
