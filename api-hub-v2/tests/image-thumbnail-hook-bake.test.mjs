import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/lib/image-routes.js';

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

function imageResponse(bytes = Buffer.from('fake-image-bytes')) {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
  };
}

function geminiResponse(payload) {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }]
  });
}

function combinedFetchMock({ hookMatch = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.endsWith('/api/v1/gpt4o-image/generate')) {
      return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_hook_test' } });
    }
    if (href.includes('/api/v1/gpt4o-image/record-info?taskId=')) {
      return jsonResponse({
        code: 200,
        msg: 'success',
        data: { taskId: 'task_hook_test', successFlag: 1, status: 'SUCCESS', response: { resultUrls: ['https://cdn.example.test/hook-result.png'] } }
      });
    }
    if (href === 'https://cdn.example.test/hook-result.png') return imageResponse();
    if (href.includes('generativelanguage.googleapis.com')) {
      return geminiResponse({ detectedText: 'Try This First', matches: hookMatch });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return { fetchImpl, calls };
}

const gptEnv = { KIE_API_KEY: 'test-secret', KIE_THUMBNAIL_MODEL: 'gpt4o-image', GEMINI_API_KEY: 'gemini-test-key' };

test('a thumbnail with hookText and gpt4o-image bakes the hook into the prompt and skips the "no visible text" tail', async () => {
  const { fetchImpl, calls } = combinedFetchMock();
  // gpt4o-image is always async: the submission call only ever returns pending:true, and
  // completion (and therefore the hook-match QA) is only observed on a later poll call,
  // exactly as the worker's own scheduler behaves across ticks.
  const submitted = await generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', aspectRatio: '16:9', hookText: 'Try This First' }, undefined, fetchImpl);
  assert.equal(submitted.pending, true);

  const createCall = calls.find((call) => call.url.endsWith('/api/v1/gpt4o-image/generate'));
  const body = JSON.parse(createCall.init.body);
  assert.match(body.prompt, /Try This First/);
  assert.doesNotMatch(body.prompt, /No visible text/i);

  const result = await generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', taskId: submitted.taskId, hookText: 'Try This First' }, undefined, fetchImpl);
  assert.equal(result.hookBaked, true);
  assert.equal(result.imageQa.mode, 'hook-match');
  assert.equal(result.imageQa.pass, true);
  assert.equal(result.imageQa.detectedText, 'Try This First');
});

test('a hook text mismatch fails the completing poll with IMAGE_HOOK_TEXT_MISMATCH instead of the generic QA rejection', async () => {
  const { fetchImpl } = combinedFetchMock({ hookMatch: false });
  const submitted = await generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', aspectRatio: '16:9', hookText: 'Try This First' }, undefined, fetchImpl);
  await assert.rejects(
    () => generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', taskId: submitted.taskId, hookText: 'Try This First' }, undefined, fetchImpl),
    (error) => {
      assert.equal(error.message, 'IMAGE_HOOK_TEXT_MISMATCH');
      assert.equal(error.status, 502);
      return true;
    }
  );
});

test('a thumbnail without hookText uses the standard "no visible text" prompt and never calls Gemini hook-match', async () => {
  const { fetchImpl, calls } = combinedFetchMock();
  const submitted = await generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', aspectRatio: '16:9' }, undefined, fetchImpl);

  const createCall = calls.find((call) => call.url.endsWith('/api/v1/gpt4o-image/generate'));
  const body = JSON.parse(createCall.init.body);
  assert.match(body.prompt, /No visible text/i);

  const result = await generateImage(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', taskId: submitted.taskId }, undefined, fetchImpl);
  assert.equal(result.hookBaked, undefined);
  assert.ok(!calls.some((call) => call.url.includes('generativelanguage.googleapis.com')));
});

test('hookText is ignored for a z-image (non-gpt4o) thumbnail, since z-image cannot reliably render text', async () => {
  const zImageEnv = { KIE_API_KEY: 'test-secret', GEMINI_API_KEY: 'gemini-test-key' };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.endsWith('/api/v1/jobs/createTask')) return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_z' } });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const result = await generateImage(zImageEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', providerMode: 'kie', aspectRatio: '16:9', hookText: 'Try This First' }, undefined, fetchImpl);

  const createCall = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(createCall.init.body);
  assert.match(body.input.prompt, /No visible text/i);
  assert.doesNotMatch(body.input.prompt, /Try This First/);
  assert.equal(result.model, 'z-image');
  assert.equal(result.hookBaked, undefined);
});

test('hookText is ignored for a body-role image even when supplied by mistake', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.endsWith('/api/v1/jobs/createTask')) return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_body' } });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const result = await generateImage(gptEnv, { role: 'body', prompt: 'A garden tool scene', providerMode: 'kie', aspectRatio: '4:3', hookText: 'Try This First' }, undefined, fetchImpl);
  assert.equal(result.hookBaked, undefined);
  assert.ok(!calls.some((call) => call.url.includes('generativelanguage.googleapis.com')));
});
