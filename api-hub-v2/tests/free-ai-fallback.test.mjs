import test from 'node:test';
import assert from 'node:assert/strict';
import { runFreeAi, freeAiModel, classifyFreeAiFailure } from '../src/lib/free-ai.js';
import { runPrimaryWithGeminiFallback } from '../src/lib/ai-provider-router.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

const REQUEST = Object.freeze({
  cloudflare: {
    model: '@cf/openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 32
  },
  gemini: {
    model: 'gemini-3.5-flash-lite',
    systemInstruction: 'VERY LARGE MASTER PREFIX\n--- SERVER AUTOMATION ADAPTER ---\nReturn JSON only.',
    userContent: JSON.stringify({ topic: 'test', language: 'ko' }),
    maxOutputTokens: 4096,
    thinking: 'minimal'
  }
});

test('Free.ai client uses OpenAI-compatible chat endpoint and Bearer auth', async () => {
  let seenUrl = '';
  let seenInit = null;
  const result = await runFreeAi({
    FREE_AI_API_KEY: 'sk-free-test',
    FREE_AI_MODEL: 'qwen7b',
    FREE_AI_REQUEST_TIMEOUT_MS: '10000'
  }, {
    model: 'qwen7b',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128,
    responseFormat: { type: 'json_object' }
  }, async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonResponse({
      model: 'qwen7b',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    });
  });

  assert.equal(seenUrl, 'https://api.free.ai/v1/chat/');
  assert.equal(seenInit.headers.authorization, 'Bearer sk-free-test');
  const body = JSON.parse(seenInit.body);
  assert.equal(body.model, 'qwen7b');
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(result.response, '{"ok":true}');
  assert.equal(result.model, 'qwen7b');
});

test('Gemini retries first, then Free.ai runs before Workers AI', async () => {
  let geminiCalls = 0;
  let freeAiCalls = 0;
  let workersCalls = 0;
  let freeAiBody = null;

  const result = await runPrimaryWithGeminiFallback({
    GEMINI_API_KEY: 'gemini-key',
    FREE_AI_API_KEY: 'sk-free-test',
    FREE_AI_FALLBACK_ENABLED: 'true',
    FREE_AI_MODEL: 'qwen7b',
    TEXT_PRIMARY_PROVIDER: 'gemini',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
    AI_PROVIDER_RETRY_DELAY_MS: '0'
  }, REQUEST, aiMock(() => {
    workersCalls += 1;
    return { response: 'workers-must-not-run' };
  }), async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return jsonResponse({ error: { message: 'temporary unavailable' } }, 503);
    }
    if (target === 'https://api.free.ai/v1/chat/') {
      freeAiCalls += 1;
      freeAiBody = JSON.parse(init.body);
      return jsonResponse({
        model: 'qwen7b',
        choices: [{ message: { content: '{"article":{"title":"T","html":"<p>x</p>","searchDescription":"d","labels":[],"sources":[],"language":"ko","topic":"test"}}' } }],
        usage: { total_tokens: 100 }
      });
    }
    throw new Error(`UNEXPECTED_URL:${target}`);
  });

  assert.equal(result.provider, 'free-ai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'GEMINI_UNAVAILABLE');
  assert.equal(geminiCalls, 2);
  assert.equal(freeAiCalls, 1);
  assert.equal(workersCalls, 0);
  assert.equal(freeAiBody.model, 'qwen7b');
  assert.equal(freeAiBody.messages[0].content.startsWith('--- SERVER AUTOMATION ADAPTER ---'), true);
  assert.equal(freeAiBody.messages[0].content.includes('VERY LARGE MASTER PREFIX'), false);
});

test('Free.ai quota exhaustion falls through to Workers AI as the final fallback', async () => {
  let workersCalls = 0;
  let freeAiCalls = 0;
  const result = await runPrimaryWithGeminiFallback({
    GEMINI_API_KEY: 'gemini-key',
    FREE_AI_API_KEY: 'sk-free-test',
    FREE_AI_FALLBACK_ENABLED: 'true',
    TEXT_PRIMARY_PROVIDER: 'gemini',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
    AI_PROVIDER_RETRY_DELAY_MS: '0'
  }, REQUEST, aiMock(() => {
    workersCalls += 1;
    return { response: 'workers-final', usage: { total_tokens: 4 } };
  }), async (url) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ error: { message: 'temporary unavailable' } }, 503);
    }
    if (target === 'https://api.free.ai/v1/chat/') {
      freeAiCalls += 1;
      return jsonResponse({ error: { message: 'daily token pool exhausted' } }, 402);
    }
    throw new Error(`UNEXPECTED_URL:${target}`);
  });

  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.response, 'workers-final');
  assert.equal(result.primaryError, 'GEMINI_UNAVAILABLE');
  assert.equal(result.secondaryError, 'FREE_AI_QUOTA_EXHAUSTED');
  assert.equal(freeAiCalls, 1);
  assert.equal(workersCalls, 1);
});

test('Free.ai role models and failure classification are deterministic', () => {
  const env = {
    FREE_AI_MODEL: 'qwen7b',
    FREE_AI_CRITIC_MODEL: 'critic-model',
    FREE_AI_REPAIR_MODEL: 'repair-model'
  };
  assert.equal(freeAiModel(env, 'writer'), 'qwen7b');
  assert.equal(freeAiModel(env, 'critic'), 'critic-model');
  assert.equal(freeAiModel(env, 'repair'), 'repair-model');
  assert.equal(classifyFreeAiFailure(402, {}).message, 'FREE_AI_QUOTA_EXHAUSTED');
  assert.equal(classifyFreeAiFailure(429, { error: { message: 'rate limit' } }).message, 'FREE_AI_RATE_LIMITED');
  assert.equal(classifyFreeAiFailure(503, {}).message, 'FREE_AI_UNAVAILABLE');
});
