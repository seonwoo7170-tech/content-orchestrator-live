import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/lib/image-routes.js';

function aiMock() {
  return { async run() { throw new Error('Workers AI should not be used in forced KIE tests'); } };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function imageResponse(bytes = Buffer.from('paid-kie-image')) {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
  };
}

function geminiResponse(payload) {
  return jsonResponse({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(payload) }] },
      finishReason: 'STOP'
    }]
  });
}

function kieSuccessRoute(counters) {
  return async (url) => {
    const value = String(url);
    if (value.endsWith('/api/v1/jobs/createTask')) {
      counters.kieCreates += 1;
      return jsonResponse({ code: 200, msg: 'success', data: { taskId: `task_${counters.kieCreates}` } });
    }
    if (value.includes('/api/v1/jobs/recordInfo?taskId=')) {
      return jsonResponse({
        code: 200,
        msg: 'success',
        data: {
          state: 'success',
          resultJson: JSON.stringify({ resultUrls: ['https://cdn.example.test/kie.png'] })
        }
      });
    }
    if (value === 'https://cdn.example.test/kie.png') return imageResponse();
    return null;
  };
}

const env = {
  KIE_API_KEY: 'test-kie-secret',
  GEMINI_API_KEY: 'test-gemini-secret',
  IMAGE_QA_REQUIRED: 'true',
  IMAGE_QA_MAX_ATTEMPTS: '3'
};

test('paid KIE image is not regenerated when Gemini QA gives a real rejection', async () => {
  const counters = { kieCreates: 0, geminiCalls: 0 };
  const kieRoute = kieSuccessRoute(counters);
  const fetchImpl = async (url, init = {}) => {
    const kie = await kieRoute(url, init);
    if (kie) return kie;
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      counters.geminiCalls += 1;
      return geminiResponse({ pass: false, detectedText: ['ABC'], violations: ['readable text'], semanticMatch: true, semanticReason: '' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const input = { role: 'thumbnail', prompt: 'main water shutoff', providerMode: 'kie', aspectRatio: '16:9' };
  const pending = await generateImage(env, input, aiMock(), fetchImpl);
  assert.equal(pending.pending, true);
  assert.equal(pending.taskId, 'task_1');
  assert.equal(counters.kieCreates, 1);
  assert.equal(counters.geminiCalls, 0);

  await assert.rejects(
    () => generateImage(
      env,
      { ...input, taskId: pending.taskId },
      aiMock(),
      fetchImpl
    ),
    (error) => {
      assert.equal(error.message, 'IMAGE_QA_REJECTED');
      assert.equal(error.qaAttempts, 1);
      return true;
    }
  );

  assert.equal(counters.kieCreates, 1);
  assert.equal(counters.geminiCalls, 1);
});

test('transient Gemini outage rechecks the same paid KIE image without regeneration', async () => {
  const counters = { kieCreates: 0, geminiCalls: 0 };
  const kieRoute = kieSuccessRoute(counters);
  const fetchImpl = async (url, init = {}) => {
    const kie = await kieRoute(url, init);
    if (kie) return kie;
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      counters.geminiCalls += 1;
      if (counters.geminiCalls === 1) return jsonResponse({ error: { message: 'temporary' } }, 503);
      return geminiResponse({ pass: true, detectedText: [], violations: [], semanticMatch: true, semanticReason: '' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const input = { role: 'thumbnail', prompt: 'main water shutoff', providerMode: 'kie', aspectRatio: '16:9' };
  const pending = await generateImage(env, input, aiMock(), fetchImpl);
  assert.equal(pending.pending, true);
  assert.equal(pending.taskId, 'task_1');
  assert.equal(counters.kieCreates, 1);
  assert.equal(counters.geminiCalls, 0);

  const result = await generateImage(
    env,
    { ...input, taskId: pending.taskId },
    aiMock(),
    fetchImpl
  );

  assert.equal(counters.kieCreates, 1);
  assert.equal(counters.geminiCalls, 2);
  assert.equal(result.provider, 'kie-ai');
  assert.equal(result.imageQa.pass, true);
  assert.equal(result.imageQa.attempts, 1);
  assert.equal(result.imageQa.inspectionAttempts, 2);
});
