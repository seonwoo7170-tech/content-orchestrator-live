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

// Jobs 165 and 172 died on 2026-09-20 with CRITIC_SCHEMA_INVALID / CRITIC_ISSUE_SCHEMA_INVALID
// while gpt-oss-120b sat idle: the contract check ran after the provider chain had closed, so
// the single most common 7B failure -- valid JSON in the wrong shape -- was the one case the
// fallback could not rescue. Every contract error must now reach Cloudflare.
test('critic falls back to Workers AI when free-ai returns valid JSON in the wrong shape', async () => {
  const malformed = [
    { payload: { verdict: 'ok', score: 100 }, primaryError: 'CRITIC_SCHEMA_INVALID' },
    { payload: { status: 'PASS', score: 'excellent', issues: [] }, primaryError: 'CRITIC_SCORE_INVALID' },
    {
      payload: { status: 'FAIL', score: 70, issues: [{ code: 'VAGUE', severity: 'LOW', location: '', reason: 'r', repairInstruction: 'i' }] },
      primaryError: 'CRITIC_ISSUE_SCHEMA_INVALID'
    },
    { payload: { status: 'FAIL', score: 70, issues: [] }, primaryError: 'CRITIC_FAIL_WITHOUT_ISSUES' }
  ];

  for (const { payload, primaryError } of malformed) {
    let workersCalled = false;
    const binding = {
      async run() {
        workersCalled = true;
        return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
      }
    };
    const result = await critic(FREE_AI_ENV, { article: ARTICLE }, binding, freeAiFetch(payload));
    assert.equal(workersCalled, true, `${primaryError} should have reached Workers AI`);
    assert.equal(result.provider, 'cloudflare-workers-ai');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.primaryError, primaryError);
    assert.equal(result.status, 'PASS');
  }
});

// A score below the publication threshold is a real verdict about the article, not a
// malformed answer. Retrying it on a second model would just be shopping for a more
// lenient judge, so it must still fail the job outright.
test('a below-threshold PASS score is a verdict, not a contract error, and never falls back', async () => {
  await assert.rejects(
    () => critic(FREE_AI_ENV, { article: ARTICLE }, noWorkersAi(), freeAiFetch({ status: 'PASS', score: 94, issues: [] })),
    /CRITIC_PASS_SCORE_BELOW_THRESHOLD/
  );
});

// There is no third provider: once Cloudflare has answered, its answer is the answer.
test('a contract error from the Workers AI fallback still fails the request', async () => {
  const binding = { async run() { return { response: JSON.stringify({ verdict: 'fine' }) }; } };
  await assert.rejects(
    () => critic(FREE_AI_ENV, { article: ARTICLE }, binding, freeAiFetch({ verdict: 'fine' })),
    /CRITIC_SCHEMA_INVALID/
  );
});

// The critic is a language model; its output is prose that happens to be JSON. Requiring an
// exact uppercase token was a design error, not a contract. Because both providers are
// language models they tend to make the same formatting choice, so the free-ai -> Cloudflare
// fallback could not rescue it, and jobs 214, 215, 217, 223 and 230 were all held on
// CRITIC_SCHEMA_INVALID with a finished article and a perfectly readable verdict attached.
test('a verdict the model wrote in its own casing is read, not rejected', async () => {
  for (const status of ['pass', ' PASS ', 'Passed', 'ok']) {
    const result = await critic(FREE_AI_ENV, { article: ARTICLE }, noWorkersAi(),
      freeAiFetch({ status, score: 100, issues: [] }));
    assert.equal(result.status, 'PASS', `${JSON.stringify(status)} should read as PASS`);
  }
});

test('a FAIL verdict in the model’s own casing keeps its issues and its verdict', async () => {
  const issue = {
    code: 'UNSUPPORTED_CLAIM',
    severity: 'high',
    location: 'html p 1',
    reason: 'Unsupported.',
    repairInstruction: 'Qualify the statement.'
  };
  const result = await critic(FREE_AI_ENV, { article: ARTICLE }, noWorkersAi(),
    freeAiFetch({ status: 'failed', score: 60, issues: [issue] }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.issues.length, 1);
  // Severity is normalised too, so downstream severity checks are not tripped by casing.
  assert.equal(result.issues[0].severity, 'HIGH');
});

test('a verdict that is genuinely not a verdict is still rejected by both providers', async () => {
  const badOnWorkersAi = {
    async run() { return { response: JSON.stringify({ status: 'MAYBE', score: 100, issues: [] }) }; }
  };
  await assert.rejects(
    () => critic(FREE_AI_ENV, { article: ARTICLE }, badOnWorkersAi,
      freeAiFetch({ status: 'MAYBE', score: 100, issues: [] })),
    (error) => String(error.message) === 'CRITIC_SCHEMA_INVALID'
  );
});
