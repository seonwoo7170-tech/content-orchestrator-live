import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrimaryWithGeminiFallback } from '../src/lib/ai-provider-router.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Writer-sized Gemini request keeps 12288 max tokens when Free.ai becomes the provider', async () => {
  let seenFreeAiBody = null;
  const result = await runPrimaryWithGeminiFallback({
    GEMINI_API_KEY: 'gemini-test',
    FREE_AI_API_KEY: 'free-test',
    FREE_AI_FALLBACK_ENABLED: 'true',
    FREE_AI_MODEL: 'qwen7b',
    TEXT_PRIMARY_PROVIDER: 'gemini',
    TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'false',
    AI_PROVIDER_RETRY_DELAY_MS: '0'
  }, {
    cloudflare: {
      model: '@cf/openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'unused' }],
      maxTokens: 12288
    },
    gemini: {
      model: 'gemini-3.5-flash-lite',
      systemInstruction: 'MASTER PREFIX\n--- SERVER AUTOMATION ADAPTER ---\nReturn JSON only.',
      userContent: JSON.stringify({ topic: 'test', language: 'ko' }),
      maxOutputTokens: 12288,
      thinking: 'minimal'
    }
  }, {
    async run() {
      throw new Error('WORKERS_AI_MUST_NOT_RUN');
    }
  }, async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ error: { message: 'temporary unavailable' } }, 503);
    }
    if (target === 'https://api.free.ai/v1/chat/') {
      seenFreeAiBody = JSON.parse(init.body);
      return jsonResponse({
        model: 'qwen7b',
        choices: [{ message: { content: '{"ok":true}' } }]
      });
    }
    throw new Error(`UNEXPECTED_URL:${target}`);
  });

  assert.equal(result.provider, 'free-ai');
  assert.ok(seenFreeAiBody);
  assert.equal(seenFreeAiBody.max_tokens, 12288);
});
