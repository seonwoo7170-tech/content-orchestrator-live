import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiRetryDelayMs,
  runPrimaryWithGeminiFallback,
  shouldFallbackFromCloudflare,
  shouldFallbackFromGemini
} from '../src/lib/ai-provider-router.js';

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

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
    systemInstruction: 'system',
    userContent: 'hello',
    maxOutputTokens: 32,
    thinking: 'minimal'
  }
});

test('Workers AI success remains primary and Gemini is not called', async () => {
  let geminiCalled = false;
  const result = await runPrimaryWithGeminiFallback(
    { GEMINI_API_KEY: 'gemini-key' },
    REQUEST,
    aiMock(() => ({ response: 'workers-result', usage: { total_tokens: 3 } })),
    async () => {
      geminiCalled = true;
      return jsonResponse({});
    }
  );

  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.primaryError, null);
  assert.equal(result.response, 'workers-result');
  assert.equal(geminiCalled, false);
});

test('Cloudflare account exhaustion falls back once to Gemini Flash-Lite', async () => {
  let geminiCalls = 0;
  const result = await runPrimaryWithGeminiFallback(
    { GEMINI_API_KEY: 'gemini-key' },
    REQUEST,
    aiMock(() => {
      const error = new Error('3036 daily free allocation exhausted');
      error.code = 3036;
      throw error;
    }),
    async () => {
      geminiCalls += 1;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'gemini-result' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
      });
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
  assert.equal(result.response, 'gemini-result');
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(geminiCalls, 1);
});

test('Gemini transient outage retries Gemini once before using Workers AI fallback', async () => {
  let workersCalls = 0;
  let geminiCalls = 0;
  const result = await runPrimaryWithGeminiFallback(
    {
      GEMINI_API_KEY: 'gemini-key',
      TEXT_PRIMARY_PROVIDER: 'gemini',
      TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
      AI_PROVIDER_RETRY_DELAY_MS: '0'
    },
    REQUEST,
    aiMock(() => {
      workersCalls += 1;
      return { response: 'workers-fallback-result', usage: { total_tokens: 4 } };
    }),
    async () => {
      geminiCalls += 1;
      return jsonResponse({ error: { message: 'upstream unavailable' } }, 503);
    }
  );

  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'GEMINI_UNAVAILABLE');
  assert.equal(result.response, 'workers-fallback-result');
  assert.equal(geminiCalls, 2);
  assert.equal(workersCalls, 1);
});

test('Gemini transient failure recovers on its own retry without consuming Workers AI', async () => {
  let workersCalls = 0;
  let geminiCalls = 0;
  const result = await runPrimaryWithGeminiFallback(
    {
      GEMINI_API_KEY: 'gemini-key',
      TEXT_PRIMARY_PROVIDER: 'gemini',
      TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
      AI_PROVIDER_RETRY_DELAY_MS: '0'
    },
    REQUEST,
    aiMock(() => {
      workersCalls += 1;
      return { response: 'must-not-run' };
    }),
    async () => {
      geminiCalls += 1;
      if (geminiCalls === 1) return jsonResponse({ error: { message: 'temporary' } }, 503);
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'gemini-recovered' }] }, finishReason: 'STOP' }]
      });
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.response, 'gemini-recovered');
  assert.equal(result.geminiAttempts, 2);
  assert.equal(result.geminiRetryUsed, true);
  assert.equal(geminiCalls, 2);
  assert.equal(workersCalls, 0);
});

test('final Workers AI quota failure remains visible after Gemini fallback exhaustion', async () => {
  let workersCalls = 0;
  await assert.rejects(
    () => runPrimaryWithGeminiFallback(
      {
        GEMINI_API_KEY: 'gemini-key',
        TEXT_PRIMARY_PROVIDER: 'gemini',
        TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true',
        AI_PROVIDER_RETRY_DELAY_MS: '0'
      },
      REQUEST,
      aiMock(() => {
        workersCalls += 1;
        const error = new Error('3036 daily free allocation exhausted');
        error.code = 3036;
        throw error;
      }),
      async () => jsonResponse({ error: { message: 'upstream unavailable' } }, 503)
    ),
    (error) => error.message === 'CLOUDFLARE_AI_ACCOUNT_LIMITED'
  );
  assert.equal(workersCalls, 1);
});

test('Gemini auth/config failures are never hidden by Workers AI fallback', async () => {
  let workersCalls = 0;
  await assert.rejects(
    () => runPrimaryWithGeminiFallback(
      {
        GEMINI_API_KEY: 'gemini-key',
        TEXT_PRIMARY_PROVIDER: 'gemini',
        TEXT_CLOUDFLARE_FALLBACK_ENABLED: 'true'
      },
      REQUEST,
      aiMock(() => {
        workersCalls += 1;
        return { response: 'must-not-run' };
      }),
      async () => jsonResponse({ error: { message: 'bad credentials' } }, 403)
    ),
    /GEMINI_AUTH_FAILED/
  );
  assert.equal(workersCalls, 0);
});

test('targeted Repair uses compact structured patches and reconstructs the complete Article', async () => {
  let seenBody = null;
  const article = {
    title: 'Test',
    html: '<p>Original.</p><p>Keep byte-for-byte.</p>',
    searchDescription: 'Original article.',
    labels: ['test'],
    sources: [{ name: 'Official', url: 'https://example.com' }],
    language: 'ko',
    topic: 'test topic'
  };
  const request = {
    cloudflare: {
      model: '@cf/openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'repair' }],
      maxTokens: 4096
    },
    gemini: {
      model: 'gemini-3.5-flash-lite',
      systemInstruction: 'MASTER V4.5 TARGETED REPAIR ADAPTER\nYou are a targeted repair editor. Return JSON only.',
      userContent: JSON.stringify({
        article,
        issues: [{
          code: 'TEST_FIX', severity: 'MEDIUM', location: 'html p 1',
          reason: 'Needs repair', repairInstruction: 'Repair this paragraph only.'
        }]
      }),
      maxOutputTokens: 12288,
      thinking: 'medium'
    }
  };

  const result = await runPrimaryWithGeminiFallback(
    { GEMINI_API_KEY: 'gemini-key' },
    request,
    aiMock(() => {
      const error = new Error('3036 daily free allocation exhausted');
      error.code = 3036;
      throw error;
    }),
    async (url, init) => {
      seenBody = JSON.parse(init.body);
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          patches: [{ location: 'html p 1', value: '<p>Repaired.</p>' }]
        }) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
      });
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, true);
  assert.equal(seenBody.generationConfig.maxOutputTokens, 12288);
  assert.equal(seenBody.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(seenBody.generationConfig.responseSchema.required, ['patches']);
  const compactInput = JSON.parse(seenBody.contents[0].parts[0].text);
  assert.equal(compactInput.targets.length, 1);
  assert.equal(compactInput.targets[0].location, 'html p 1');
  assert.equal(Object.prototype.hasOwnProperty.call(compactInput, 'article'), false);

  const repaired = JSON.parse(result.response);
  assert.equal(repaired.html, '<p>Repaired.</p><p>Keep byte-for-byte.</p>');
  assert.equal(repaired.title, article.title);
  assert.deepEqual(repaired.sources, article.sources);
});

test('targeted Repair patch must cover every requested location', async () => {
  const article = {
    title: 'Test', html: '<p>One.</p><p>Two.</p>', searchDescription: 'Description',
    labels: ['test'], sources: [], language: 'ko', topic: 'topic'
  };
  let calls = 0;
  await assert.rejects(
    () => runPrimaryWithGeminiFallback(
      { GEMINI_API_KEY: 'gemini-key', TEXT_PRIMARY_PROVIDER: 'gemini', AI_PROVIDER_RETRY_DELAY_MS: '0' },
      {
        cloudflare: REQUEST.cloudflare,
        gemini: {
          model: 'gemini-3.5-flash-lite',
          systemInstruction: 'MASTER V4.5 TARGETED REPAIR ADAPTER\nReturn JSON only.',
          userContent: JSON.stringify({
            article,
            issues: [
              { location: 'html p 1', repairInstruction: 'fix one' },
              { location: 'html p 2', repairInstruction: 'fix two' }
            ]
          }),
          maxOutputTokens: 4096,
          thinking: 'medium'
        }
      },
      aiMock(() => ({ response: 'unused' })),
      async () => {
        calls += 1;
        return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          patches: [{ location: 'html p 1', value: '<p>Fixed one.</p>' }]
        }) }] }, finishReason: 'STOP' }] });
      }
    ),
    /GEMINI_REQUEST_FAILED/
  );
  assert.equal(calls, 2);
});

test('Cloudflare configuration/input validation errors do not get hidden by Gemini fallback', async () => {
  let geminiCalled = false;
  await assert.rejects(
    () => runPrimaryWithGeminiFallback(
      { GEMINI_API_KEY: 'gemini-key' },
      {
        ...REQUEST,
        cloudflare: { ...REQUEST.cloudflare, model: 'not-a-cloudflare-model' }
      },
      aiMock(() => ({ response: 'unused' })),
      async () => {
        geminiCalled = true;
        return jsonResponse({});
      }
    ),
    /MODEL_NOT_ALLOWED/
  );
  assert.equal(geminiCalled, false);
});

test('Cloudflare provider failure remains visible when Gemini fallback is not configured', async () => {
  await assert.rejects(
    () => runPrimaryWithGeminiFallback(
      {},
      REQUEST,
      aiMock(() => {
        const error = new Error('3036 daily free allocation exhausted');
        error.code = 3036;
        throw error;
      }),
      async () => jsonResponse({})
    ),
    /CLOUDFLARE_AI_ACCOUNT_LIMITED/
  );
});

test('Gemini retry pacing is disabled only when explicitly set to zero, otherwise constrained to 3-5 seconds', () => {
  assert.equal(geminiRetryDelayMs({}), 4000);
  assert.equal(geminiRetryDelayMs({ AI_PROVIDER_RETRY_DELAY_MS: '0' }), 0);
  assert.equal(geminiRetryDelayMs({ AI_PROVIDER_RETRY_DELAY_MS: '1' }), 3000);
  assert.equal(geminiRetryDelayMs({ AI_PROVIDER_RETRY_DELAY_MS: '99999' }), 5000);
  assert.equal(geminiRetryDelayMs({ AI_PROVIDER_RETRY_DELAY_MS: '4200' }), 4200);
});

test('fallback policy is limited to known Cloudflare provider/runtime errors', () => {
  for (const code of [
    'CLOUDFLARE_AI_ACCOUNT_LIMITED',
    'CLOUDFLARE_AI_OUT_OF_CAPACITY',
    'CLOUDFLARE_AI_PAID_PLAN_REQUIRED',
    'CLOUDFLARE_AI_TIMEOUT',
    'CLOUDFLARE_AI_BINDING_FAILED',
    'CLOUDFLARE_AI_BINDING_REQUIRED',
    'CLOUDFLARE_AI_EMPTY_RESPONSE'
  ]) {
    assert.equal(shouldFallbackFromCloudflare(new Error(code)), true, code);
  }
  assert.equal(shouldFallbackFromCloudflare(new Error('MODEL_NOT_ALLOWED')), false);
  assert.equal(shouldFallbackFromCloudflare(new Error('CRITIC_SCHEMA_INVALID')), false);
});

test('fallback policy is limited to transient Gemini provider/runtime errors', () => {
  for (const code of [
    'GEMINI_REQUEST_FAILED',
    'GEMINI_TIMEOUT',
    'GEMINI_RATE_LIMITED',
    'GEMINI_UNAVAILABLE',
    'GEMINI_API_FAILED',
    'GEMINI_EMPTY_RESPONSE'
  ]) {
    assert.equal(shouldFallbackFromGemini(new Error(code)), true, code);
  }
  for (const code of [
    'GEMINI_AUTH_FAILED',
    'GEMINI_REQUEST_REJECTED',
    'GEMINI_MODEL_NOT_ALLOWED',
    'GEMINI_BLOCKED',
    'GEMINI_RESPONSE_SCHEMA_INVALID'
  ]) {
    assert.equal(shouldFallbackFromGemini(new Error(code)), false, code);
  }
});
