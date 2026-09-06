import test from 'node:test';
import assert from 'node:assert/strict';

const MASTER_SHA = '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('postdeploy smoke treats exhausted free AI quota as degraded, does not retry it, and continues Blogger read-only smoke', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.API_HUB_V2_BASE_URL;
  const originalKey = process.env.ORCHESTRATOR_API_KEY;
  const originalLog = console.log;
  const calls = [];

  process.env.API_HUB_V2_BASE_URL = 'https://hub.example';
  process.env.ORCHESTRATOR_API_KEY = 'test-hub-key';
  console.log = () => {};

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method || 'GET' });

    if (path === '/health') {
      return jsonResponse({
        ok: true,
        masterV45: { bundled: true, sha256: MASTER_SHA, size: 93282 },
        bloggerConfigured: true,
        bloggerWritesEnabled: true,
        bloggerWriteMode: 'managed_allowlist',
        googleOAuthSetupEnabled: false,
        googleOAuthClientConfigured: true
      });
    }

    if (path === '/api/hub/ai/diagnostics/cloudflare') {
      return jsonResponse({ ok: false, error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED' }, 429);
    }

    if (path === '/api/blogger/blogs') {
      return jsonResponse({ blogs: [{ id: '1', name: 'Test Blog' }], count: 1 });
    }

    throw new Error(`UNEXPECTED_PATH:${path}`);
  };

  try {
    await import(`../scripts/postdeploy-smoke.mjs?account-limit-test=${Date.now()}`);

    const diagnosticCalls = calls.filter((call) => call.path === '/api/hub/ai/diagnostics/cloudflare');
    const bloggerCalls = calls.filter((call) => call.path === '/api/blogger/blogs');
    assert.equal(diagnosticCalls.length, 1);
    assert.equal(bloggerCalls.length, 1);
    assert.ok(calls.every((call) => !call.path.includes('/api/blogger/post')));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalBaseUrl === undefined) delete process.env.API_HUB_V2_BASE_URL;
    else process.env.API_HUB_V2_BASE_URL = originalBaseUrl;
    if (originalKey === undefined) delete process.env.ORCHESTRATOR_API_KEY;
    else process.env.ORCHESTRATOR_API_KEY = originalKey;
  }
});
