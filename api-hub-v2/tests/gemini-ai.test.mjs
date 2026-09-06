import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiRequestTimeoutMs, runGeminiAi } from '../src/lib/gemini-ai.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Gemini request timeout is bounded and configurable', () => {
  assert.equal(geminiRequestTimeoutMs({}), 30000);
  assert.equal(geminiRequestTimeoutMs({ GEMINI_REQUEST_TIMEOUT_MS: '15000' }), 15000);
  assert.equal(geminiRequestTimeoutMs({ GEMINI_REQUEST_TIMEOUT_MS: '1' }), 1000);
  assert.equal(geminiRequestTimeoutMs({ GEMINI_REQUEST_TIMEOUT_MS: '999999' }), 60000);
});

test('runGeminiAi sends system instruction, thinking level, structured output, and a bounded signal', async () => {
  let seen = null;
  const fetchMock = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: '{"status":"PASS","score":100,"issues":[]}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45, thoughtsTokenCount: 6, totalTokenCount: 174, cachedContentTokenCount: 0 }
    });
  };
  const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
  const result = await runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'critic prompt', userContent: '{"article":{}}',
    maxOutputTokens: 4096, responseSchema: schema, thinking: 'medium'
  }, fetchMock);
  assert.match(seen.url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret-key');
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.deepEqual(seen.body.systemInstruction, { parts: [{ text: 'critic prompt' }] });
  assert.deepEqual(seen.body.contents, [{ role: 'user', parts: [{ text: '{"article":{}}' }] }]);
  assert.equal(seen.body.generationConfig.maxOutputTokens, 4096);
  assert.equal(seen.body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(seen.body.generationConfig.responseSchema, schema);
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(result.response, '{"status":"PASS","score":100,"issues":[]}');
  assert.deepEqual(result.usage, { promptTokenCount: 123, candidatesTokenCount: 45, thoughtsTokenCount: 6, totalTokenCount: 174, cachedContentTokenCount: 0 });
});

test('runGeminiAi classifies provider timeout exceptions as GEMINI_TIMEOUT for failover', async () => {
  await assert.rejects(
    () => runGeminiAi({ GEMINI_API_KEY: 'secret-key', GEMINI_REQUEST_TIMEOUT_MS: '1000' }, {
      model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user'
    }, async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }),
    (error) => error.message === 'GEMINI_TIMEOUT' && error.status === 408
  );
});

test('runGeminiAi sends a base64 image as inlineData before the inspection prompt', async () => {
  let body = null;
  const result = await runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'inspect pixels only', userContent: 'Return the image compliance result.',
    inlineImage: { mimeType: 'image/png', data: 'ZmFrZS1wbmc=' }, maxOutputTokens: 256,
    responseSchema: { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] }
  }, async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"pass":true}' }] }, finishReason: 'STOP' }] });
  });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'ZmFrZS1wbmc=' } }, { text: 'Return the image compliance result.' }] }]);
  assert.equal(result.response, '{"pass":true}');
});

test('runGeminiAi rejects unsupported inline image MIME types before network use', async () => {
  let called = false;
  await assert.rejects(() => runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user', inlineImage: { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }
  }, async () => { called = true; return jsonResponse({}); }), /GEMINI_INLINE_IMAGE_MIME_INVALID/);
  assert.equal(called, false);
});

test('runGeminiAi never exposes provider error bodies when rate limited', async () => {
  await assert.rejects(() => runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user'
  }, async () => jsonResponse({ error: { message: 'private provider detail APIKEY-DO-NOT-LEAK' } }, 429)), (error) => {
    assert.equal(error.message, 'GEMINI_RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.ok(!String(error.message).includes('APIKEY-DO-NOT-LEAK'));
    return true;
  });
});

test('runGeminiAi classifies upstream outages without raw provider text', async () => {
  await assert.rejects(() => runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user'
  }, async () => jsonResponse({ error: { message: 'backend internal trace' } }, 503)), (error) => error.message === 'GEMINI_UNAVAILABLE' && error.status === 503);
});

test('runGeminiAi rejects missing API key before any network call', async () => {
  let called = false;
  await assert.rejects(() => runGeminiAi({}, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user'
  }, async () => { called = true; return jsonResponse({}); }), /GEMINI_API_KEY_REQUIRED/);
  assert.equal(called, false);
});

test('runGeminiAi treats safety-blocked empty output as a controlled failure', async () => {
  await assert.rejects(() => runGeminiAi({ GEMINI_API_KEY: 'secret-key' }, {
    model: 'gemini-3.5-flash-lite', systemInstruction: 'system', userContent: 'user'
  }, async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })), (error) => error.message === 'GEMINI_BLOCKED' && error.status === 422);
});
