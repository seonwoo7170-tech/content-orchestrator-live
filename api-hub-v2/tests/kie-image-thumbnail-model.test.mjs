import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKieImage,
  pollKieImageTask,
  startKieImageTask
} from '../src/lib/kie-image.js';

function response(data, status = 200) {
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

const gptEnv = { KIE_API_KEY: 'test-secret', KIE_THUMBNAIL_MODEL: 'gpt4o-image' };

test('thumbnail with KIE_THUMBNAIL_MODEL=gpt4o-image calls the 4o image endpoint, not jobs/createTask', async () => {
  let gptCreateCount = 0;
  let zImageCreateCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/gpt4o-image/generate')) {
      gptCreateCount += 1;
      return response({ code: 200, msg: 'success', data: { taskId: 'task_gpt' } });
    }
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      zImageCreateCount += 1;
      throw new Error('thumbnail must not use the z-image endpoint when gpt4o-image is configured');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await startKieImageTask(gptEnv, { role: 'thumbnail', prompt: 'A clean kitchen scene', aspectRatio: '16:9' }, fetchImpl);

  assert.equal(gptCreateCount, 1);
  assert.equal(zImageCreateCount, 0);
  assert.equal(result.model, 'gpt4o-image');
  assert.equal(result.taskId, 'task_gpt');
  assert.equal(result.pending, true);
});

test('body images stay on z-image even when KIE_THUMBNAIL_MODEL=gpt4o-image is configured', async () => {
  let gptCreateCount = 0;
  let zImageCreateCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/gpt4o-image/generate')) {
      gptCreateCount += 1;
      throw new Error('body images must not use gpt4o-image');
    }
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      zImageCreateCount += 1;
      return response({ code: 200, msg: 'success', data: { taskId: 'task_z' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await startKieImageTask(gptEnv, { role: 'body', prompt: 'A clean repair scene', aspectRatio: '4:3' }, fetchImpl);

  assert.equal(zImageCreateCount, 1);
  assert.equal(gptCreateCount, 0);
  assert.equal(result.model, 'z-image');
  assert.equal(result.taskId, 'task_z');
});

test('thumbnail defaults to z-image when KIE_THUMBNAIL_MODEL is not set (no behavior change unless opted in)', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      return response({ code: 200, msg: 'success', data: { taskId: 'task_default' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await startKieImageTask({ KIE_API_KEY: 'test-secret' }, { role: 'thumbnail', prompt: 'A scene', aspectRatio: '16:9' }, fetchImpl);
  assert.equal(result.model, 'z-image');
});

test('an unrecognized KIE_THUMBNAIL_MODEL value is rejected rather than silently used', async () => {
  await assert.rejects(
    () => startKieImageTask({ KIE_API_KEY: 'test-secret', KIE_THUMBNAIL_MODEL: 'some-other-model' }, { role: 'thumbnail', prompt: 'x', aspectRatio: '16:9' }, async () => { throw new Error('must not fetch'); }),
    (error) => {
      assert.equal(error.message, 'KIE_THUMBNAIL_MODEL_NOT_ALLOWED');
      return true;
    }
  );
});

test('resuming a pending gpt4o-image task polls record-info and does not recreate it', async () => {
  let createCount = 0;
  let queryCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/gpt4o-image/generate')) {
      createCount += 1;
      throw new Error('must not create a second task');
    }
    if (String(url).includes('/api/v1/gpt4o-image/record-info?taskId=task_gpt_pending')) {
      queryCount += 1;
      return response({ code: 200, msg: 'success', data: { taskId: 'task_gpt_pending', successFlag: 0, progress: 40 } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await generateKieImage(gptEnv, { role: 'thumbnail', prompt: 'A scene', aspectRatio: '16:9', taskId: 'task_gpt_pending' }, fetchImpl);

  assert.equal(createCount, 0);
  assert.equal(queryCount, 1);
  assert.equal(result.model, 'gpt4o-image');
  assert.equal(result.pending, true);
  assert.equal(result.complete, false);
});

test('a successful gpt4o-image task downloads from response.resultUrls', async () => {
  let downloadCount = 0;
  const resultUrl = 'https://example.com/gpt-generated.png';
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/gpt4o-image/record-info?taskId=task_gpt_done')) {
      return response({
        code: 200,
        msg: 'success',
        data: { taskId: 'task_gpt_done', successFlag: 1, status: 'SUCCESS', response: { resultUrls: [resultUrl] } }
      });
    }
    if (String(url) === resultUrl) {
      downloadCount += 1;
      return imageResponse([4, 5, 6], 'image/png');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await pollKieImageTask(gptEnv, 'task_gpt_done', fetchImpl, 'thumbnail');

  assert.equal(downloadCount, 1);
  assert.equal(result.pending, false);
  assert.equal(result.complete, true);
  assert.equal(result.model, 'gpt4o-image');
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.imageBase64);
});

test('a failed gpt4o-image task (successFlag 2 or 3) surfaces only a safe category, no raw provider text', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/gpt4o-image/record-info?taskId=task_gpt_failed')) {
      return response({
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task_gpt_failed',
          successFlag: 3,
          errorCode: 500,
          errorMessage: 'Internal error, please try again later. secret provider detail must stay hidden'
        }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => pollKieImageTask(gptEnv, 'task_gpt_failed', fetchImpl, 'thumbnail'),
    (error) => {
      assert.equal(error.message, 'KIE_PROVIDER_GENERATION_FAILED');
      assert.equal(error.status, 502);
      assert.equal(error.providerCode, 500);
      assert.doesNotMatch(error.message, /secret provider detail/i);
      return true;
    }
  );
});
