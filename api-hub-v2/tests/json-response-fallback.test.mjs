import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrimaryWithGeminiFallback } from '../src/lib/ai-provider-router.js';

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function freeAiResponse(text) {
  return new Response(JSON.stringify({
    model: 'qwen7b',
    choices: [{ message: { content: text } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function requests() {
  return {
    gemini: {
      model: 'gemini-3.5-flash-lite',
      systemInstruction: 'Return JSON only.',
      userContent: '{"task":"test"}',
      maxOutputTokens: 512
    },
    cloudflare: {
      model: '@cf/openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: '{"task":"test"}' }
      ],
      maxTokens: 512
    }
  };
}

test('invalid Gemini JSON retries Gemini then falls back to Free.ai', async () => {
  let geminiCalls = 0;
  let freeAiCalls = 0;
  let cloudflareCalls = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return geminiResponse('this is not json');
    }
    if (href.includes('api.free.ai')) {
      freeAiCalls += 1;
      return freeAiResponse('{"ok":true}');
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  const binding = {
    async run() {
      cloudflareCalls += 1;
      return { response: '{"ok":true}' };
    }
  };

  const result = await runPrimaryWithGeminiFallback({
    TEXT_PRIMARY_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key',
    FREE_AI_API_KEY: 'test-free-key',
    FREE_AI_FALLBACK_ENABLED: 'true',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
    AI_PROVIDER_RETRY_DELAY_MS: 0
  }, requests(), binding, fetchImpl);

  assert.equal(geminiCalls, 2);
  assert.equal(freeAiCalls, 1);
  assert.equal(cloudflareCalls, 0);
  assert.equal(result.provider, 'free-ai');
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(JSON.parse(result.response), { ok: true });
});

test('invalid Gemini and Free.ai JSON continue to Workers AI', async () => {
  let geminiCalls = 0;
  let freeAiCalls = 0;
  let cloudflareCalls = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return geminiResponse('invalid-gemini-json');
    }
    if (href.includes('api.free.ai')) {
      freeAiCalls += 1;
      return freeAiResponse('invalid-free-ai-json');
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  const binding = {
    async run() {
      cloudflareCalls += 1;
      return { response: '{"ok":true,"provider":"cloudflare"}' };
    }
  };

  const result = await runPrimaryWithGeminiFallback({
    TEXT_PRIMARY_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key',
    FREE_AI_API_KEY: 'test-free-key',
    FREE_AI_FALLBACK_ENABLED: 'true',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
    AI_PROVIDER_RETRY_DELAY_MS: 0
  }, requests(), binding, fetchImpl);

  assert.equal(geminiCalls, 2);
  assert.equal(freeAiCalls, 1);
  assert.equal(cloudflareCalls, 1);
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(JSON.parse(result.response), { ok: true, provider: 'cloudflare' });
});
