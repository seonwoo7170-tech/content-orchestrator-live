import test from 'node:test';
import assert from 'node:assert/strict';
import { critic } from '../src/lib/ai-routes.js';

function workersAiWithCriticJson() {
  return {
    async run() {
      return {
        response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }),
        usage: { total_tokens: 10 }
      };
    }
  };
}

// Critic used to run on Gemini exclusively and fall back to Workers AI only on a
// transient Gemini outage. Removed at the operator's request (suspected of driving
// repair() to progressively trim long articles across successive critic->repair
// rounds) -- critic now runs on Workers AI only and never touches Gemini, even when a
// Gemini key is configured and even if Workers AI itself is unavailable.
test('critic runs on Workers AI even when a Gemini key is configured, and never calls Gemini', async () => {
  let geminiCalled = false;
  const article = {
    title: 'Test',
    html: '<p>Body.</p>',
    searchDescription: 'Description',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'topic'
  };
  const result = await critic(
    {
      GEMINI_API_KEY: 'test-key',
      GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite',
      CRITIC_MODEL: '@cf/openai/gpt-oss-120b',
      TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true'
    },
    { article },
    workersAiWithCriticJson(),
    async () => { geminiCalled = true; throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); }
  );
  assert.equal(result.status, 'PASS');
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.auditMode, 'master-v4.5-role-critic-free-ai-granular');
  assert.equal(geminiCalled, false);
});

test('critic surfaces a Workers AI outage directly instead of silently recovering through Gemini', async () => {
  const article = {
    title: 'Test',
    html: '<p>Body.</p>',
    searchDescription: 'Description',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'topic'
  };
  const failingWorkersAi = { async run() { throw new Error('WORKERS_AI_UNAVAILABLE'); } };
  await assert.rejects(
    () => critic(
      { GEMINI_API_KEY: 'test-key', TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true' },
      { article },
      failingWorkersAi,
      async () => { throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); }
    ),
    /CLOUDFLARE_AI_BINDING_FAILED/
  );
});
