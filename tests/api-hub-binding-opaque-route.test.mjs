import test from 'node:test';
import assert from 'node:assert/strict';
import { callHub } from '../worker/lib/api-hub.js';

for (const status of [404, 405]) {
  test(`text AI route preserves opaque service-binding ${status} and never falls back to public HTTPS`, async () => {
    let publicCalls = 0;
    const env = {
      API_HUB_BASE_URL: 'https://api-hub-v2.example',
      HUB_API_KEY: 'secret',
      API_HUB_SERVICE: {
        async fetch() {
          return new Response('Not Found', { status });
        }
      }
    };

    await assert.rejects(
      () => callHub(env, '/api/hub/ai/writer', { topic: 'test', language: 'en' }, async () => {
        publicCalls += 1;
        return new Response(JSON.stringify({ article: { title: 'wrong transport' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }),
      new RegExp(`API_HUB_${status}`)
    );

    assert.equal(publicCalls, 0);
  });
}

test('Blogger read keeps service-binding 404 authoritative and never public-fallbacks', async () => {
  let publicCalls = 0;
  const env = {
    API_HUB_BASE_URL: 'https://api-hub-v2.example',
    HUB_API_KEY: 'secret',
    API_HUB_SERVICE: {
      async fetch() {
        return new Response('Not Found', { status: 404 });
      }
    }
  };

  await assert.rejects(
    () => callHub(env, '/api/blogger/post/get', { blogId: '11', bloggerPostId: '22' }, async () => {
      publicCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
    /API_HUB_404/
  );
  assert.equal(publicCalls, 0);
});
