import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateModelScopeImage,
  pollModelScopeImageTask,
  startModelScopeImageTask
} from '../src/lib/modelscope-image.js';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function imageResponse(bytes = [1, 2, 3], contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
  };
}

test('ModelScope submit uses the documented async image endpoint and returns task id without polling', async () => {
  let submitCount = 0;
  let pollCount = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === 'https://api-inference.modelscope.ai/v1/images/generations') {
      submitCount += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer test-token');
      assert.equal(init.headers['content-type'], 'application/json');
      assert.equal(init.headers['X-ModelScope-Async-Mode'], 'true');
      assert.deepEqual(JSON.parse(init.body), {
        model: 'Qwen/Qwen-Image',
        prompt: 'a cute black cat sitting on a desk, soft light'
      });
      return jsonResponse({ task_id: 'ms_task_1' });
    }
    if (String(url).includes('/v1/tasks/')) {
      pollCount += 1;
      throw new Error('submit must not poll in the same Worker invocation');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await startModelScopeImageTask(
    { MODELSCOPE_TOKEN: 'test-token' },
    { prompt: 'a cute black cat sitting on a desk, soft light' },
    fetchImpl
  );

  assert.equal(submitCount, 1);
  assert.equal(pollCount, 0);
  assert.equal(result.provider, 'modelscope-ai');
  assert.equal(result.model, 'Qwen/Qwen-Image');
  assert.equal(result.taskId, 'ms_task_1');
  assert.equal(result.pending, true);
  assert.equal(result.complete, false);
});

test('ModelScope pending task resumes by polling without submitting another generation', async () => {
  let submitCount = 0;
  let pollCount = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/v1/images/generations')) {
      submitCount += 1;
      throw new Error('must not create a second task');
    }
    if (String(url).endsWith('/v1/tasks/ms_existing')) {
      pollCount += 1;
      assert.equal(init.headers.authorization, 'Bearer test-token');
      assert.equal(init.headers['X-ModelScope-Task-Type'], 'image_generation');
      return jsonResponse({ task_status: 'RUNNING' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await generateModelScopeImage(
    { MODELSCOPE_TOKEN: 'test-token' },
    { prompt: 'ignored while resuming', taskId: 'ms_existing' },
    fetchImpl
  );

  assert.equal(submitCount, 0);
  assert.equal(pollCount, 1);
  assert.equal(result.taskId, 'ms_existing');
  assert.equal(result.state, 'running');
  assert.equal(result.pending, true);
  assert.equal(result.complete, false);
});

test('ModelScope successful task downloads output_images[0] and returns base64 bytes', async () => {
  let pollCount = 0;
  let downloadCount = 0;
  const resultUrl = 'https://example.com/modelscope-output.png';
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v1/tasks/ms_success')) {
      pollCount += 1;
      return jsonResponse({ task_status: 'SUCCEED', output_images: [resultUrl] });
    }
    if (String(url) === resultUrl) {
      downloadCount += 1;
      return imageResponse([7, 8, 9], 'image/png');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await pollModelScopeImageTask(
    { MODELSCOPE_TOKEN: 'test-token' },
    'ms_success',
    fetchImpl
  );

  assert.equal(pollCount, 1);
  assert.equal(downloadCount, 1);
  assert.equal(result.provider, 'modelscope-ai');
  assert.equal(result.taskId, 'ms_success');
  assert.equal(result.state, 'success');
  assert.equal(result.pending, false);
  assert.equal(result.complete, true);
  assert.equal(result.sourceUrl, resultUrl);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.imageBase64, 'BwgJ');
});

test('ModelScope FAILED task stops the provider chain cleanly', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/v1/tasks/ms_failed')) {
      return jsonResponse({ task_status: 'FAILED', message: 'provider detail' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => pollModelScopeImageTask({ MODELSCOPE_TOKEN: 'test-token' }, 'ms_failed', fetchImpl),
    (error) => {
      assert.equal(error.message, 'MODELSCOPE_IMAGE_GENERATION_FAILED');
      assert.equal(error.status, 502);
      return true;
    }
  );
});

test('ModelScope auth failures are classified separately from validation failures', async () => {
  const fetchImpl = async () => jsonResponse({ message: 'unauthorized' }, 401);
  await assert.rejects(
    () => startModelScopeImageTask({ MODELSCOPE_TOKEN: 'bad-token' }, { prompt: 'test prompt' }, fetchImpl),
    (error) => {
      assert.equal(error.message, 'MODELSCOPE_AUTH_FAILED');
      assert.equal(error.status, 401);
      assert.equal(error.providerHttpStatus, 401);
      return true;
    }
  );
});

test('ModelScope token is required before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('network should not be reached');
  };
  await assert.rejects(
    () => startModelScopeImageTask({}, { prompt: 'test prompt' }, fetchImpl),
    /MODELSCOPE_TOKEN_REQUIRED/
  );
  assert.equal(calls, 0);
});