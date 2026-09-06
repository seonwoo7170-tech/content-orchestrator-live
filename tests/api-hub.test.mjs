import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHubUrl, callHub, hubHeaders, hubPublicFallbackAllowed, hubPublicFallbackStatusAllowed, hubRequestTimeoutMs } from '../worker/lib/api-hub.js';

test('API Hub URL is deterministic', () => {
  assert.equal(buildHubUrl({ API_HUB_BASE_URL: 'https://hub.example/' }, '/api/test'), 'https://hub.example/api/test');
});

test('API Hub key is sent only as x-hub-api-key', () => {
  const headers = hubHeaders({ HUB_API_KEY: 'secret' });
  assert.equal(headers['x-hub-api-key'], 'secret');
  assert.equal(headers.authorization, undefined);
});

test('API Hub timeout is bounded and configurable', () => {
  assert.equal(hubRequestTimeoutMs({}), 60000);
  assert.equal(hubRequestTimeoutMs({ HUB_REQUEST_TIMEOUT_MS: '25' }), 25);
  assert.equal(hubRequestTimeoutMs({ HUB_REQUEST_TIMEOUT_MS: '1' }), 10);
  assert.equal(hubRequestTimeoutMs({ HUB_REQUEST_TIMEOUT_MS: '999999' }), 180000);
});

test('legacy public-fallback capability remains limited to side-effect-free/read routes', () => {
  for (const path of [
    '/api/hub/ai/topic', '/api/hub/ai/writer', '/api/hub/ai/critic', '/api/hub/ai/repair',
    '/api/hub/ai/diagnostics/cloudflare', '/api/blogger/blogs', '/api/blogger/post/get'
  ]) assert.equal(hubPublicFallbackAllowed(path), true, path);
  assert.equal(hubPublicFallbackAllowed('/api/blogger/post'), false);
  assert.equal(hubPublicFallbackAllowed('/api/hub/image/generate'), false);
});

test('legacy fallback statuses remain route mismatch only', () => {
  for (const status of [404, 405]) assert.equal(hubPublicFallbackStatusAllowed(status), true, String(status));
  for (const status of [200, 400, 401, 403, 409, 429, 500, 503]) assert.equal(hubPublicFallbackStatusAllowed(status), false, String(status));
});

test('API Hub calls use public HTTPS only when no service binding exists', async () => {
  let publicCalls = 0;
  const env = { API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret' };
  const result = await callHub(env, '/api/test', { hello: 'world' }, async (url, init) => {
    publicCalls += 1;
    assert.equal(new URL(url).pathname, '/api/test');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(publicCalls, 1);
});

test('API Hub calls prefer Cloudflare service binding and never touch public HTTPS when present', async () => {
  let serviceRequest;
  let publicFetchCalled = false;
  const env = {
    API_HUB_BASE_URL: 'https://api-hub-v2.example', HUB_API_KEY: 'secret',
    API_HUB_SERVICE: { async fetch(request) { serviceRequest = request; return new Response(JSON.stringify({ ok: true }), { status: 200 }); } }
  };
  const result = await callHub(env, '/api/test', { hello: 'world' }, async () => {
    publicFetchCalled = true;
    throw new Error('PUBLIC_FETCH_SHOULD_NOT_RUN');
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(publicFetchCalled, false);
  assert.equal(serviceRequest.url, 'https://api-hub-v2.example/api/test');
  assert.equal(serviceRequest.method, 'POST');
  assert.equal(serviceRequest.headers.get('x-hub-api-key'), 'secret');
  assert.ok(serviceRequest.signal);
  assert.deepEqual(await serviceRequest.json(), { hello: 'world' });
});

for (const status of [404, 405, 500, 503]) {
  test(`service binding HTTP ${status} is authoritative and never overwritten by public HTTPS`, async () => {
    let publicCalls = 0;
    const errorName = status === 404 ? 'NOT_FOUND' : status === 405 ? 'METHOD_NOT_ALLOWED' : 'temporary';
    const env = {
      API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret',
      API_HUB_SERVICE: { async fetch() { return new Response(JSON.stringify({ error: errorName }), { status }); } }
    };
    await assert.rejects(
      () => callHub(env, '/api/hub/ai/writer', { topic: 'test' }, async () => {
        publicCalls += 1;
        return new Response(JSON.stringify({ article: { title: 'wrong transport' } }), { status: 200 });
      }),
      new RegExp(`API_HUB_${status}`)
    );
    assert.equal(publicCalls, 0);
  });
}

test('handled provider 503 from service binding preserves the provider code', async () => {
  let publicCalls = 0;
  const env = {
    API_HUB_BASE_URL: 'https://api-hub-v2.example', HUB_API_KEY: 'secret',
    API_HUB_SERVICE: { async fetch() { return new Response(JSON.stringify({ error: 'GEMINI_UNAVAILABLE' }), { status: 503 }); } }
  };
  await assert.rejects(async () => {
    try {
      await callHub(env, '/api/hub/ai/writer', { topic: 'test' }, async () => { publicCalls += 1; return new Response('', { status: 404 }); });
    } catch (error) {
      assert.equal(error.code, 'GEMINI_UNAVAILABLE');
      assert.equal(error.providerCode, 'GEMINI_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.routeMissing, false);
      throw error;
    }
  }, /API_HUB_503:GEMINI_UNAVAILABLE/);
  assert.equal(publicCalls, 0);
});

test('service binding transport exception becomes a bounded transient API_HUB_503 and never public-fallbacks', async () => {
  let publicCalls = 0;
  const env = {
    API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret',
    API_HUB_SERVICE: { async fetch() { throw new Error('socket-reset-internal-detail'); } }
  };
  await assert.rejects(async () => {
    try {
      await callHub(env, '/api/hub/ai/writer', { topic: 'test' }, async () => { publicCalls += 1; return new Response('{}', { status: 200 }); });
    } catch (error) {
      assert.equal(error.code, 'API_HUB_503');
      assert.equal(error.providerCode, 'API_HUB_BINDING_FAILED');
      assert.equal(error.status, 503);
      throw error;
    }
  }, /API_HUB_503:API_HUB_BINDING_FAILED/);
  assert.equal(publicCalls, 0);
});

test('upstream Blogger 404 is preserved instead of being mislabeled as a route 404', async () => {
  const env = { API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret' };
  await assert.rejects(async () => {
    try {
      await callHub(env, '/api/blogger/post/get', { blogId: '11', bloggerPostId: '22' }, async () =>
        new Response(JSON.stringify({ error: 'BLOGGER_API_404' }), { status: 404 }));
    } catch (error) {
      assert.equal(error.code, 'BLOGGER_API_404');
      assert.equal(error.routeMissing, false);
      throw error;
    }
  }, /API_HUB_404:BLOGGER_API_404/);
});

test('true stale route canonicalizes once over public transport when no binding exists', async () => {
  const calls = [];
  const env = { API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret' };
  const result = await callHub(env, '/legacy/critic', { article: {} }, async (url) => {
    calls.push(new URL(url).pathname);
    if (calls.length === 1) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify({ status: 'PASS', score: 100, issues: [] }), { status: 200 });
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['/legacy/critic', '/api/hub/ai/critic']);
});

test('true stale route canonicalizes once over the same service binding', async () => {
  const calls = [];
  let publicCalls = 0;
  const env = {
    API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret',
    API_HUB_SERVICE: { async fetch(request) {
      calls.push(new URL(request.url).pathname);
      if (calls.length === 1) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      return new Response(JSON.stringify({ status: 'PASS', score: 100, issues: [] }), { status: 200 });
    } }
  };
  const result = await callHub(env, '/legacy/critic', { article: {} }, async () => { publicCalls += 1; throw new Error('PUBLIC_SHOULD_NOT_RUN'); });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['/legacy/critic', '/api/hub/ai/critic']);
  assert.equal(publicCalls, 0);
});

test('API Hub calls fail with a bounded timeout instead of hanging the scheduler', async () => {
  const env = { API_HUB_BASE_URL: 'https://hub.example', HUB_API_KEY: 'secret', HUB_REQUEST_TIMEOUT_MS: '15' };
  const hangingFetch = async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const started = Date.now();
  await assert.rejects(() => callHub(env, '/api/test', {}, hangingFetch), /API_HUB_TIMEOUT/);
  assert.ok(Date.now() - started < 500, 'timeout guard should fail promptly in tests');
});
