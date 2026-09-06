import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrimaryWithGeminiFallback } from '../src/lib/ai-provider-router.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const REQUEST = Object.freeze({
  cloudflare: {
    model: '@cf/openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 32
  },
  gemini: {
    model: 'gemini-3.5-flash-lite',
    systemInstruction: '--- SERVER AUTOMATION ADAPTER ---\nReturn JSON only.',
    userContent: JSON.stringify({ topic: 'test', language: 'ko' }),
    maxOutputTokens: 256,
    thinking: 'minimal'
  }
});

test('preserves the final Workers AI failure after Gemini and Free.ai are exhausted', async () => {
  const env = {
    GEMINI_API_KEY: 'gemini-key',
    FREE_AI_API_KEY: 'sk-free-test',
    FREE_AI_FALLBACK_ENABLED: 'true',
    FREE_AI_MODEL: 'qwen7b',
    TEXT_PRIMARY_PROVIDER: 'gemini',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
    AI_PROVIDER_RETRY_DELAY_MS: '0'
  };

  const aiBinding = {
    async run() {
      const cause = new Error('3036 daily free allocation exceeded');
      cause.code = 3036;
      throw cause;
    }
  };

  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ error: { message: 'rate limit' } }, 429);
    }
    if (target === 'https://api.free.ai/v1/chat/') {
      return jsonResponse({ error: { message: 'daily token pool exhausted' } }, 402);
    }
    throw new Error(`UNEXPECTED_URL:${target}`);
  };

  await assert.rejects(
    () => runPrimaryWithGeminiFallback(env, REQUEST, aiBinding, fetchImpl),
    (error) => {
      assert.equal(error.message, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
      assert.equal(error.status, 429);
      return true;
    }
  );
});
