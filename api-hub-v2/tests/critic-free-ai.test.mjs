import test from 'node:test';
import assert from 'node:assert/strict';
import { critic } from '../src/lib/ai-routes.js';

const FREE_AI_ENV = Object.freeze({
  FREE_AI_API_KEY: 'test-free-ai-key',
  FREE_AI_FALLBACK_ENABLED: 'true',
  FREE_AI_CRITIC_MODEL: 'qwen7b',
  CRITIC_MODEL: '@cf/openai/gpt-oss-120b',
  GEMINI_API_KEY: 'should-be-ignored'
});

const ARTICLE = {
  title: 'Test',
  html: '<p>Body.</p>',
  searchDescription: 'Description',
  labels: [],
  sources: [],
  language: 'en',
  topic: 'topic'
};

function freeAiFetch(payload, status = 200) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: JSON.stringify(payload) } }]
    }), { status, headers: { 'content-type': 'application/json' } });
  };
}

function noWorkersAi() {
  return { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } };
}

// Critic used to run on Gemini exclusively, then briefly on the same Cloudflare model
// family as writer/repair -- both undermine independent review (a model grading its own
// output, or a stand-in for it). Critic now defaults to free-ai (qwen7b) as primary, a
// genuinely distinct model, with Cloudflare only as an availability fallback.
test('critic runs on free-ai when configured, never touching Workers AI or Gemini', async () => {
  let geminiCalled = false;
  const result = await critic(
    FREE_AI_ENV,
    { article: ARTICLE },
    noWorkersAi(),
    async (url, init) => {
      if (String(url).includes('generativelanguage')) { geminiCalled = true; throw new Error('unexpected'); }
      return freeAiFetch({ status: 'PASS', score: 100, issues: [] })(url, init);
    }
  );
  assert.equal(result.provider, 'free-ai');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.status, 'PASS');
  assert.equal(result.auditMode, 'master-v4.5-role-critic-free-ai-granular');
  assert.equal(geminiCalled, false);
});

test('critic falls back to Workers AI when free-ai is unavailable', async () => {
  let workersCalled = false;
  const binding = {
    async run() {
      workersCalled = true;
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
    }
  };
  const result = await critic(
    FREE_AI_ENV,
    { article: ARTICLE },
    binding,
    async () => new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 503 })
  );
  assert.equal(workersCalled, true);
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'FREE_AI_UNAVAILABLE');
  assert.equal(result.status, 'PASS');
});

test('critic falls back to Workers AI when free-ai returns unparseable JSON', async () => {
  const binding = {
    async run() {
      return { response: JSON.stringify({ status: 'FAIL', score: 80, issues: [{ code: 'X', severity: 'LOW', location: 'title', reason: 'r', repairInstruction: 'i' }] }) };
    }
  };
  const result = await critic(
    FREE_AI_ENV,
    { article: ARTICLE },
    binding,
    async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not json at all' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  );
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.status, 'FAIL');
});

test('critic uses Workers AI directly when free-ai is not configured, still skipping Gemini', async () => {
  let geminiCalled = false;
  const binding = {
    async run() {
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
    }
  };
  const result = await critic(
    { CRITIC_MODEL: '@cf/openai/gpt-oss-120b', GEMINI_API_KEY: 'ignored' },
    { article: ARTICLE },
    binding,
    async () => { geminiCalled = true; throw new Error('unexpected'); }
  );
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, false);
  assert.equal(geminiCalled, false);
});
