import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKieImage,
  normalizeAspectRatio,
  pollKieImageTask,
  safePromptForKie,
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

test('KIE start returns task id without polling the provider', async () => {
  let createCount = 0;
  let queryCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      createCount += 1;
      return response({ code: 200, msg: 'success', data: { taskId: 'task_async' } });
    }
    if (String(url).includes('/api/v1/jobs/recordInfo?taskId=')) {
      queryCount += 1;
      throw new Error('status must not be queried during task creation');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await startKieImageTask(
    { KIE_API_KEY: 'test-secret' },
    { role: 'thumbnail', prompt: 'A clean household maintenance scene', aspectRatio: '16:9' },
    fetchImpl
  );

  assert.equal(createCount, 1);
  assert.equal(queryCount, 0);
  assert.equal(result.provider, 'kie-ai');
  assert.equal(result.taskId, 'task_async');
  assert.equal(result.pending, true);
  assert.equal(result.complete, false);
});

test('KIE pending task is resumable without creating another paid task', async () => {
  let createCount = 0;
  let queryCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      createCount += 1;
      throw new Error('must not create a second task');
    }
    if (String(url).includes('/api/v1/jobs/recordInfo?taskId=task_existing')) {
      queryCount += 1;
      return response({ code: 200, msg: 'success', data: { taskId: 'task_existing', state: 'generating' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await generateKieImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt: 'A clean repair scene', aspectRatio: '4:3', taskId: 'task_existing' },
    fetchImpl
  );

  assert.equal(createCount, 0);
  assert.equal(queryCount, 1);
  assert.equal(result.taskId, 'task_existing');
  assert.equal(result.state, 'generating');
  assert.equal(result.pending, true);
});

test('KIE successful task downloads the existing result without recreating it', async () => {
  let createCount = 0;
  let queryCount = 0;
  let downloadCount = 0;
  const resultUrl = 'https://example.com/generated.png';
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      createCount += 1;
      throw new Error('must not create a second task');
    }
    if (String(url).includes('/api/v1/jobs/recordInfo?taskId=task_success')) {
      queryCount += 1;
      return response({
        code: 200,
        msg: 'success',
        data: { taskId: 'task_success', state: 'success', resultJson: JSON.stringify({ resultUrls: [resultUrl] }) }
      });
    }
    if (String(url) === resultUrl) {
      downloadCount += 1;
      return imageResponse([7, 8, 9], 'image/png');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await pollKieImageTask({ KIE_API_KEY: 'test-secret' }, 'task_success', fetchImpl);
  assert.equal(createCount, 0);
  assert.equal(queryCount, 1);
  assert.equal(downloadCount, 1);
  assert.equal(result.pending, false);
  assert.equal(result.complete, true);
  assert.equal(result.provider, 'kie-ai');
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.imageBase64);
});

test('KIE failed task exposes only safe provider code and category', async () => {
  let queryCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/jobs/recordInfo?taskId=task_test')) {
      queryCount += 1;
      return response({
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task_test',
          state: 'fail',
          failCode: 500,
          failMsg: 'Internal error, please try again later. secret provider detail must stay hidden'
        }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => pollKieImageTask({ KIE_API_KEY: 'test-secret' }, 'task_test', fetchImpl),
    (error) => {
      assert.equal(error.message, 'KIE_PROVIDER_GENERATION_FAILED');
      assert.equal(error.status, 502);
      assert.equal(error.providerCode, 500);
      assert.doesNotMatch(error.message, /secret provider detail/i);
      return true;
    }
  );
  assert.equal(queryCount, 1);
});

test('KIE z-image uses only supported ratios and maps legacy ratios safely', () => {
  assert.equal(normalizeAspectRatio('1:1', 'body'), '1:1');
  assert.equal(normalizeAspectRatio('4:3', 'body'), '4:3');
  assert.equal(normalizeAspectRatio('3:4', 'body'), '3:4');
  assert.equal(normalizeAspectRatio('16:9', 'thumbnail'), '16:9');
  assert.equal(normalizeAspectRatio('9:16', 'body'), '9:16');
  assert.equal(normalizeAspectRatio('3:2', 'body'), '4:3');
  assert.equal(normalizeAspectRatio('2:3', 'body'), '3:4');
  assert.equal(normalizeAspectRatio('unsupported', 'thumbnail'), '16:9');
  assert.equal(normalizeAspectRatio('unsupported', 'body'), '4:3');
});

test('monitor flicker prompt preserves the article-specific subject and adds blank-screen safety', () => {
  const source = 'A realistic editorial photograph focused on 모니터 깜빡임 핵심 답 및 진단 순서.';
  const prompt = safePromptForKie(source);
  assert.match(prompt, /모니터 깜빡임 핵심 답 및 진단 순서/);
  assert.match(prompt, /blank or featureless/i);
  assert.match(prompt, /No visible text/i);
});

test('monitor cable prompt preserves semantics and adds physical connection safety', () => {
  const source = 'A realistic editorial photograph focused on 단계 케이블 및 물리적 연결 상태 확인 within the broader context of 모니터 화면 깜빡임 현상.';
  const prompt = safePromptForKie(source);
  assert.match(prompt, /단계 케이블 및 물리적 연결 상태 확인/);
  assert.match(prompt, /blank or featureless/i);
  assert.match(prompt, /No visible text/i);
});

test('unrelated KIE prompt keeps its semantic subject while receiving common safety constraints', () => {
  const source = 'A realistic editorial photograph of a shower fixture.';
  const prompt = safePromptForKie(source);
  assert.match(prompt, /A realistic editorial photograph of a shower fixture\./);
  assert.match(prompt, /No visible text/i);
  assert.match(prompt, /unbranded/i);
});
