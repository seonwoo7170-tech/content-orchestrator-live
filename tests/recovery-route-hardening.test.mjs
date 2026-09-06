import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callHub, canonicalHubPath } from '../worker/lib/api-hub.js';

test('canonicalHubPath maps stale AI route overrides to managed API Hub routes', () => {
  assert.equal(canonicalHubPath('/old/api/critic'), '/api/hub/ai/critic');
  assert.equal(canonicalHubPath('/legacy/repair'), '/api/hub/ai/repair');
  assert.equal(canonicalHubPath('/v1/blogger/post/get'), '/api/blogger/post/get');
});

test('callHub retries a stale configured route once on the canonical route', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === '/old/api/critic') {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, route: path }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const result = await callHub({
    API_HUB_BASE_URL: 'https://hub.example.test',
    HUB_API_KEY: 'test-key',
    HUB_REQUEST_TIMEOUT_MS: 1000
  }, '/old/api/critic', { article: {} }, fetchImpl);

  assert.deepEqual(seen, ['/old/api/critic', '/api/hub/ai/critic']);
  assert.equal(result.ok, true);
  assert.equal(result.route, '/api/hub/ai/critic');
});

test('read-only Blogger routes preserve a live service-binding 404 instead of switching transports', async () => {
  const bindingSeen = [];
  const publicSeen = [];
  const env = {
    API_HUB_BASE_URL: 'https://hub.example.test',
    HUB_API_KEY: 'test-key',
    HUB_REQUEST_TIMEOUT_MS: 1000,
    API_HUB_SERVICE: {
      async fetch(request) {
        bindingSeen.push(new URL(request.url).pathname);
        return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
  };
  const fetchImpl = async (url) => {
    publicSeen.push(new URL(url).pathname);
    return new Response(JSON.stringify({ ok: true, post: { id: '1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await assert.rejects(
    () => callHub(env, '/api/blogger/post/get', { blogId: '1', postId: '1' }, fetchImpl),
    /API_HUB_404:NOT_FOUND/
  );
  assert.deepEqual(bindingSeen, ['/api/blogger/post/get']);
  assert.deepEqual(publicSeen, []);
});

test('claiming a queued job clears stale recovery metadata before live progress is shown', () => {
  const source = readFileSync(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
  const claim = source.slice(source.indexOf('export async function claimStoredJobExecution'), source.indexOf('export async function resetStoredJobForManualRetry'));
  for (const fragment of [
    "recovery_state = 'none'",
    'next_retry_at = NULL',
    'hold_reason = NULL',
    'last_error_code = NULL',
    'last_failure_at = NULL'
  ]) assert.match(claim, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('legacy 404/405 revival clears old error metadata instead of carrying it into the new run', () => {
  const source = readFileSync(new URL('../worker/lib/legacy-route-cleanup.js', import.meta.url), 'utf8');
  const revive = source.slice(source.indexOf('const revivedJobIds'), source.indexOf('return {', source.indexOf('const revivedJobIds')));
  assert.match(revive, /last_error_code = NULL/);
  assert.match(revive, /last_failure_at = NULL/);
  assert.match(revive, /error = NULL/);
});
