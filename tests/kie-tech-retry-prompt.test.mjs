import test from 'node:test';
import assert from 'node:assert/strict';
import { retryPromptForImage } from '../worker/lib/image-executor.js';

const techPrompt = 'Photorealistic real-world photograph focused on pc 렉 걸림 끝판왕 원인별 진단 및 체감 속도 % 개선 최적화 마스터 가이드. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';

test('PC QA recovery prompt changes from KIE retry level 2 to level 3', () => {
  const level2 = retryPromptForImage({
    status: 'failed',
    error: 'API_HUB_502:IMAGE_QA_REJECTED',
    prompt: techPrompt,
    provider_task_id: 'task-1',
    provider_attempt_count: 1
  });
  const level3 = retryPromptForImage({
    status: 'failed',
    error: 'API_HUB_502:IMAGE_QA_REJECTED',
    prompt: techPrompt,
    provider_task_id: 'task-2',
    provider_attempt_count: 2
  });

  assert.match(level2, /KIE_RECOVERY_LEVEL_2/);
  assert.match(level2, /open unbranded desktop computer case/i);
  assert.match(level2, /cooling fan/i);
  assert.match(level2, /sleeved cable/i);

  assert.match(level3, /KIE_RECOVERY_LEVEL_3/);
  assert.match(level3, /extreme tight close-up/i);
  assert.match(level3, /single plain black computer cooling fan housing/i);
  assert.match(level3, /circuit boards.*out of frame/i);
  assert.notEqual(level2, level3);
});

test('legacy KIE task without attempt count still receives level 2 recovery', () => {
  const retry = retryPromptForImage({
    status: 'failed',
    error: 'IMAGE_QA_REJECTED',
    prompt: techPrompt,
    provider_task_id: 'legacy-task',
    provider_attempt_count: 0
  });
  assert.match(retry, /KIE_RECOVERY_LEVEL_2/);
});
