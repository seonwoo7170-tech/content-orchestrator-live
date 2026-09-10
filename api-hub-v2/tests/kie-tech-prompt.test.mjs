import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/lib/image-routes.js';

function aiMock() {
  return { async run() { throw new Error('WORKERS_AI_SHOULD_NOT_RUN'); } };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

async function captureKieCreatePrompt(prompt) {
  let createBody = null;
  const result = await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'thumbnail', prompt, providerMode: 'kie', aspectRatio: '16:9' },
    aiMock(),
    async (url, init = {}) => {
      if (String(url).endsWith('/api/v1/jobs/createTask')) {
        createBody = JSON.parse(init.body);
        return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task-tech-test' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  );
  assert.equal(result.pending, true);
  assert.ok(createBody);
  return String(createBody.input.prompt || '');
}

const source = 'Photorealistic real-world photograph focused on pc 렉 걸림 끝판왕 원인별 진단 및 체감 속도 % 개선 최적화 마스터 가이드. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';

test('KIE preserves a Korean PC performance subject instead of replacing it with cleaning', async () => {
  const prompt = await captureKieCreatePrompt(source);
  assert.match(prompt, /pc 렉 걸림 끝판왕 원인별 진단 및 체감 속도 % 개선 최적화 마스터 가이드/i);
  assert.match(prompt, /No visible text, letters, numbers, logos, icons, UI/i);
  assert.doesNotMatch(prompt, /cleaning brush|ventilation grille/i);
});

test('orchestrator KIE recovery levels remain distinct after API Hub prompt preparation', async () => {
  const level2 = await captureKieCreatePrompt(`${source} KIE_RECOVERY_LEVEL_2. Recovery visual rule: simplify the composition to a closer view.`);
  const level3 = await captureKieCreatePrompt(`${source} KIE_RECOVERY_LEVEL_3. Recovery visual rule: use an even tighter close-up with minimum physical elements.`);

  assert.match(level2, /pc 렉 걸림/i);
  assert.match(level2, /Close-up view, very simple composition/i);

  assert.match(level3, /pc 렉 걸림/i);
  assert.match(level3, /Tight close-up, minimal scene elements/i);
  assert.notEqual(level2, level3);
});
