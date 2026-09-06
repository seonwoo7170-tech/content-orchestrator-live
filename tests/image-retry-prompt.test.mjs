import test from 'node:test';
import assert from 'node:assert/strict';
import { retryPromptForImage } from '../worker/lib/image-executor.js';

test('QA-rejected monitor image retry uses a blank-screen recovery prompt', () => {
  const prompt = retryPromptForImage({
    status: 'failed',
    error: 'API_HUB_502:IMAGE_QA_REJECTED',
    prompt: 'Photorealistic real-world photograph focused on 모니터 깜빡임 핵심 답 및 진단 순서.'
  });
  assert.match(prompt, /blank uniform dark screen/i);
  assert.match(prompt, /no visible text/i);
  assert.match(prompt, /no UI/i);
});

test('QA-rejected monitor cable retry focuses on unlabeled physical connection', () => {
  const prompt = retryPromptForImage({
    status: 'failed',
    error: 'API_HUB_502:IMAGE_QA_REJECTED',
    prompt: 'Photorealistic real-world photograph focused on 단계 케이블 및 물리적 연결 상태 확인 within the broader context of 모니터 화면 깜빡임 현상.'
  });
  assert.match(prompt, /rear or lower edge of one monitor/i);
  assert.match(prompt, /plain unbranded cable/i);
  assert.match(prompt, /unlabeled/i);
});

test('normal and timeout retries keep the original semantic prompt', () => {
  const original = 'Photorealistic real-world photograph focused on a shower fixture.';
  assert.equal(retryPromptForImage({ status: 'planned', prompt: original }), original);
  assert.equal(retryPromptForImage({ status: 'failed', error: 'API_HUB_504:KIE_IMAGE_TIMEOUT', prompt: original }), original);
});
