import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGptActionsOpenApi, handleGptActionRequest } from '../worker/lib/gpt-actions.js';

const env = { ADMIN_API_KEY: 'admin-secret' };
const ctx = { waitUntil() {} };

function actionRequest(path, options = {}) {
  const headers = new Headers({
    authorization: `Bearer ${options.token || 'admin-secret'}`,
    accept: 'application/json',
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
  });
  return new Request(`https://content-orchestrator.smileseon.workers.dev${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function fakeDownstream(handler = null) {
  const calls = [];
  return {
    calls,
    async fetch(req) {
      calls.push({
        url: req.url,
        method: req.method,
        admin: req.headers.get('x-admin-api-key'),
        body: req.method === 'GET' ? null : await req.clone().text()
      });
      if (handler) return handler(req, calls);
      return Response.json({ ok: true });
    }
  };
}

test('OpenAPI schema is public, bearer-authenticated for operations, and marks mutations consequential', async () => {
  const downstream = fakeDownstream();
  const request = new Request('https://content-orchestrator.smileseon.workers.dev/actions/openapi.json');
  const response = await handleGptActionRequest(request, env, ctx, downstream);
  assert.equal(response.status, 200);
  const schema = await response.json();
  assert.equal(schema.openapi, '3.1.0');
  assert.equal(schema.servers[0].url, 'https://content-orchestrator.smileseon.workers.dev');
  assert.equal(schema.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.equal(schema.paths['/actions/jobs'].get.operationId, 'listJobs');
  assert.equal(schema.paths['/actions/jobs'].get['x-openai-isConsequential'], false);
  assert.equal(schema.paths['/actions/publish-tick'].post['x-openai-isConsequential'], true);
  assert.equal(downstream.calls.length, 0);
});

test('operational Action endpoints require Bearer authorization', async () => {
  const request = new Request('https://content-orchestrator.smileseon.workers.dev/actions/jobs');
  const response = await handleGptActionRequest(request, env, ctx, fakeDownstream());
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Bearer/i);
});

test('GPT action can use a dedicated key without exposing it to the internal admin API', async () => {
  const localEnv = { ADMIN_API_KEY: 'admin-secret', GPT_ACTION_API_KEY: 'gpt-only-secret' };
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/blogs') return Response.json({ blogs: [{ id: 'b1' }] });
    throw new Error(`unexpected ${url.pathname}`);
  });
  const response = await handleGptActionRequest(actionRequest('/actions/blogs', { token: 'gpt-only-secret' }), localEnv, ctx, downstream);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).blogs[0].id, 'b1');
  assert.equal(downstream.calls[0].admin, 'admin-secret');
});

test('listJobs Action reuses the existing Smileseon admin API path', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') return Response.json({ jobs: [{ id: 95, status: 'failed' }], count: 1 });
    throw new Error(`unexpected ${url.pathname}`);
  });
  const response = await handleGptActionRequest(actionRequest('/actions/jobs?limit=20&status=failed'), env, ctx, downstream);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.count, 1);
  assert.match(downstream.calls[0].url, /\/api\/jobs\?limit=20&status=failed/);
  assert.equal(downstream.calls[0].admin, 'admin-secret');
});

test('protected jobs 36-42 remain blocked through GPT Actions', async () => {
  const downstream = fakeDownstream();
  const response = await handleGptActionRequest(actionRequest('/actions/jobs/36/retry', { method: 'POST', body: {} }), env, ctx, downstream);
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.match(data.error, /MCP_PROTECTED_JOB_36/);
  assert.equal(downstream.calls.length, 0);
});

test('publish Action inherits the protected-ready-job fail closed guard', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') return Response.json({ jobs: [{ id: 37, status: 'ready' }], count: 1 });
    throw new Error('publish endpoint must not be reached');
  });
  const response = await handleGptActionRequest(actionRequest('/actions/publish-tick', { method: 'POST', body: { skipImages: false } }), env, ctx, downstream);
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.match(data.error, /MCP_PROTECTED_JOB_37_BLOCKS_PUBLISH_TICK/);
  assert.equal(downstream.calls.length, 1);
});

test('repair Action reuses an existing repair job for the same Blogger post', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') {
      return Response.json({ jobs: [{ id: 95, mode: 'repair_existing', blog_id: 'b1', blogger_post_id: 'p1', status: 'failed' }] });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  const response = await handleGptActionRequest(actionRequest('/actions/jobs/repair-existing', {
    method: 'POST', body: { blogId: 'b1', bloggerPostId: 'p1', targetUrl: 'https://example.com/post' }
  }), env, ctx, downstream);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reusedExisting, true);
  assert.equal(data.jobId, 95);
  assert.equal(downstream.calls.length, 1);
});

test('Worker config sends Actions to worker before static assets', () => {
  const entry = readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
  const wrangler = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
  assert.match(entry, /handleGptActionRequest/);
  assert.match(entry, /pathname\.startsWith\('\/actions\/'\)/);
  assert.match(wrangler, /"\/actions\/\*"/);
  const schema = buildGptActionsOpenApi();
  assert.ok(Object.keys(schema.paths).length >= 10);
});
