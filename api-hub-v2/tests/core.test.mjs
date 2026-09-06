import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAuthorized } from '../src/lib/auth.js';
import { assertAllowedModel, runWorkersAi } from '../src/lib/cloudflare-ai.js';
import { critic, diagnostic, writer } from '../src/lib/ai-routes.js';
import { loadMasterV45 } from '../src/lib/master-v45-bundle.js';
import { MASTER_V45 } from '../src/lib/contracts.js';
import { googleOAuthConfigured, getGoogleAccessToken } from '../src/lib/google-oauth.js';
import { getPost, listBlogs, writePost } from '../src/lib/blogger.js';

function req(key) {
  return new Request('https://hub.example/test', { headers: key ? { 'x-hub-api-key': key } : {} });
}

function aiMock(responseFactory) {
  return {
    async run(model, body) {
      return typeof responseFactory === 'function' ? responseFactory(model, body) : responseFactory;
    }
  };
}

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function googleMock(handler) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(init.headers?.authorization, 'Bearer access-token');
    return handler(String(url), init);
  };
}

test('v2 accepts only the single orchestrator key', () => {
  assert.equal(isAuthorized(req('same-key'), { ORCHESTRATOR_API_KEY: 'same-key' }), true);
  assert.equal(isAuthorized(req('wrong'), { ORCHESTRATOR_API_KEY: 'same-key' }), false);
  assert.equal(isAuthorized(req(), { ORCHESTRATOR_API_KEY: 'same-key' }), false);
});

test('Workers AI binding accepts approved @cf model ids only', () => {
  assert.equal(assertAllowedModel('@cf/openai/gpt-oss-120b'), '@cf/openai/gpt-oss-120b');
  assert.throws(() => assertAllowedModel('arbitrary-model'), /MODEL_NOT_ALLOWED/);
});

test('Workers AI runs through native binding without provider token or account id', async () => {
  let seen;
  const binding = aiMock((model, body) => {
    seen = { model, body };
    return { response: 'OK', usage: { input_tokens: 1 } };
  });
  const result = await runWorkersAi({}, { model: '@cf/openai/gpt-oss-120b', prompt: 'OK' }, binding);
  assert.equal(result.response, 'OK');
  assert.equal(seen.model, '@cf/openai/gpt-oss-120b');
  assert.deepEqual(seen.body, { prompt: 'OK' });
});

test('Workers AI fails closed when binding is missing', async () => {
  await assert.rejects(
    () => runWorkersAi({}, { model: '@cf/openai/gpt-oss-120b', prompt: 'OK' }, null),
    /CLOUDFLARE_AI_BINDING_REQUIRED/
  );
});

test('diagnostic requires an actual OK model response', async () => {
  const result = await diagnostic(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    aiMock({ response: 'OK' })
  );
  assert.equal(result.ok, true);
  assert.equal(result.model, '@cf/openai/gpt-oss-120b');
});

test('bundled Master v4.5 has the exact pinned byte length and SHA-256', async () => {
  const master = await loadMasterV45();
  const bytes = Buffer.from(master, 'utf8');
  assert.equal(bytes.byteLength, MASTER_V45.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MASTER_V45.sha256);
  assert.match(master, /^# 한글·영문 공통 블로그 마스터 지침/);
});

test('writer sends exact Master v4.5 plus the non-interactive Blogger adapter', async () => {
  let payload;
  const binding = aiMock((model, body) => {
    payload = body;
    return {
      response: JSON.stringify({
        article: {
          title: 'Test article',
          html: '<p>Useful answer.</p>',
          searchDescription: 'Useful answer for the requested topic.',
          labels: ['guide'],
          sources: [],
          language: 'en',
          topic: 'test topic'
        }
      })
    };
  });

  const result = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    { blogId: '11', topic: 'test topic', language: 'en' },
    binding
  );

  assert.equal(result.article.title, 'Test article');
  assert.equal(result.masterV45.sha256, MASTER_V45.sha256);
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /^# 한글·영문 공통 블로그 마스터 지침/);
  assert.match(payload.messages[0].content, /SERVER AUTOMATION ADAPTER/);
  assert.match(payload.messages[0].content, /Do not ask questions/);
  assert.equal(payload.messages[1].content.includes('test topic'), true);
});

test('writer rejects missing or unsupported language before provider use', async () => {
  await assert.rejects(() => writer({}, { topic: 'x', language: 'ja' }), /WRITER_LANGUAGE_INVALID/);
  await assert.rejects(() => writer({}, { topic: '', language: 'ko' }), /WRITER_TOPIC_REQUIRED/);
});

test('critic enforces PASS with zero issues through dedicated Gemini provider', async () => {
  let workersCalled = false;
  const result = await critic(
    { GEMINI_API_KEY: 'test-key', GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite' },
    { article: {} },
    { async run() { workersCalled = true; throw new Error('unexpected Workers call'); } },
    async () => geminiResponse(JSON.stringify({ status: 'PASS', score: 98, issues: [] }))
  );
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.issues, []);
  assert.equal(result.provider, 'google-gemini');
  assert.equal(workersCalled, false);
});

test('Google OAuth is explicitly configured only when all three secrets exist', () => {
  assert.equal(googleOAuthConfigured(GOOGLE_ENV), true);
  assert.equal(googleOAuthConfigured({ ...GOOGLE_ENV, GOOGLE_REFRESH_TOKEN: '' }), false);
});

test('Google refresh exchange returns access token without exposing provider payload', async () => {
  const token = await getGoogleAccessToken(GOOGLE_ENV, googleMock(() => {
    throw new Error('unexpected provider call');
  }));
  assert.equal(token, 'access-token');
});

test('Blogger list normalizes connected blogs', async () => {
  const fetchImpl = googleMock(async (url) => {
    assert.match(url, /\/blogger\/v3\/users\/self\/blogs/);
    return new Response(JSON.stringify({ items: [{ id: '11', name: 'Example', url: 'https://example.blogspot.com/', locale: { language: 'en' }, posts: { totalItems: 7 } }] }), { status: 200 });
  });
  const result = await listBlogs(GOOGLE_ENV, fetchImpl);
  assert.equal(result.count, 1);
  assert.deepEqual(result.blogs[0], {
    id: '11',
    blogId: '11',
    name: 'Example',
    blogName: 'Example',
    url: 'https://example.blogspot.com/',
    language: 'en',
    postsTotal: 7,
    updated: null
  });
});

test('Blogger get preserves the requested post identity', async () => {
  const fetchImpl = googleMock(async (url) => {
    if (url.endsWith('/blogs/11')) {
      return new Response(JSON.stringify({ id: '11', locale: { language: 'en' } }), { status: 200 });
    }
    assert.match(url, /\/blogs\/11\/posts\/22\?view=ADMIN$/);
    return new Response(JSON.stringify({ id: '22', blog: { id: '11' }, title: 'Existing', content: '<p>Hello world</p>', labels: ['guide'], url: 'https://example.blogspot.com/p.html', status: 'LIVE' }), { status: 200 });
  });
  const result = await getPost(GOOGLE_ENV, { blogId: '11', bloggerPostId: '22' }, fetchImpl);
  assert.equal(result.identity.blogId, '11');
  assert.equal(result.identity.bloggerPostId, '22');
  assert.equal(result.article.language, 'en');
  assert.equal(result.article.searchDescription, 'Existing');
});

test('Blogger create defaults to draft and update preserves the same post ID', async () => {
  const calls = [];
  const fetchImpl = googleMock(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') {
      assert.match(url, /\/blogs\/11\/posts\?isDraft=true$/);
      return new Response(JSON.stringify({ id: '33', title: 'Draft', status: 'DRAFT' }), { status: 200 });
    }
    assert.equal(init.method, 'PUT');
    assert.match(url, /\/blogs\/11\/posts\/33$/);
    return new Response(JSON.stringify({ id: '33', title: 'Updated', status: 'LIVE' }), { status: 200 });
  });

  const created = await writePost(GOOGLE_ENV, { blogId: '11', operation: 'create', article: { title: 'Draft', html: '<p>x</p>', labels: [] } }, fetchImpl);
  assert.equal(created.bloggerPostId, '33');
  assert.equal(created.status, 'DRAFT');

  const updated = await writePost(GOOGLE_ENV, { blogId: '11', bloggerPostId: '33', operation: 'update', article: { title: 'Updated', html: '<p>y</p>', labels: [] } }, fetchImpl);
  assert.equal(updated.bloggerPostId, '33');
  assert.equal(calls.length, 2);
});
