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

test('critic falls back from transient Gemini outage to Workers AI when enabled', async () => {
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
    async () => new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  );
  assert.equal(result.status, 'PASS');
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'GEMINI_UNAVAILABLE');
  assert.equal(result.auditMode, 'master-v4.5-role-critic-gemini-granular');
});
