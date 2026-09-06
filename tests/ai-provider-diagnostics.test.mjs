import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnoseCloudflareViaHub } from '../worker/lib/provider-diagnostics.js';

const env = {
  API_HUB_BASE_URL: 'https://hub.example.test',
  HUB_API_KEY: 'test-key',
  AI_STAGE_PACING_MS: 0
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('AI diagnostics reports Gemini available when Workers AI is rate limited', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/health') {
      return jsonResponse({
        geminiConfigured: true,
        geminiCriticModel: 'gemini-3.5-flash-lite',
        freeAiConfigured: true,
        freeAiFallbackEnabled: true,
        freeAiCriticModel: 'qwen7b'
      });
    }
    if (path === '/api/hub/ai/diagnostics/cloudflare') {
      return jsonResponse({ ok: false, error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED' }, 429);
    }
    if (path === '/api/hub/ai/critic') {
      return jsonResponse({
        status: 'FAIL',
        score: 80,
        issues: [{ code: 'TEST_ONLY', severity: 'LOW', location: 'html p 1', reason: 'test', repairInstruction: 'test' }],
        provider: 'google-gemini',
        model: 'gemini-3.5-flash-lite',
        fallbackUsed: false,
        primaryError: null
      });
    }
    return jsonResponse({ error: 'NOT_FOUND' }, 404);
  };

  const result = await diagnoseCloudflareViaHub(env, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.usable, true);
  assert.equal(result.activeProvider, 'google-gemini');
  assert.equal(result.providers.gemini.state, 'available');
  assert.equal(result.providers.freeAi.state, 'standby');
  assert.equal(result.providers.workersAi.state, 'limited');
});

test('AI diagnostics keeps Workers AI as available when its direct probe succeeds', async () => {
  let criticCalled = false;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/health') {
      return jsonResponse({
        geminiConfigured: true,
        freeAiConfigured: true,
        freeAiFallbackEnabled: true
      });
    }
    if (path === '/api/hub/ai/diagnostics/cloudflare') {
      return jsonResponse({ ok: true, model: '@cf/openai/gpt-oss-120b', response: 'OK' });
    }
    if (path === '/api/hub/ai/critic') criticCalled = true;
    return jsonResponse({ error: 'NOT_FOUND' }, 404);
  };

  const result = await diagnoseCloudflareViaHub(env, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.activeProvider, 'cloudflare-workers-ai');
  assert.equal(result.providers.workersAi.state, 'available');
  assert.equal(result.providers.gemini.state, 'configured');
  assert.equal(result.providers.freeAi.state, 'standby');
  assert.equal(criticCalled, false);
});
