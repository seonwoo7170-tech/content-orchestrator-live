import test from 'node:test';
import assert from 'node:assert/strict';
import { runNewArticlePipeline } from '../worker/lib/pipeline.js';

const env = {
  API_HUB_BASE_URL: 'https://hub.example.test',
  HUB_API_KEY: 'test-key'
};

function article(html) {
  return {
    title: 'PC가 갑자기 느려졌을 때 확인할 순서',
    html,
    searchDescription: '갑자기 느려진 PC에서 먼저 확인할 항목을 순서대로 설명합니다.',
    labels: ['PC'],
    sources: [],
    language: 'ko',
    topic: 'PC 속도 점검'
  };
}

function criticIssue() {
  return {
    code: 'READABILITY',
    severity: 'LOW',
    location: 'html p 1',
    reason: 'Sentence is dense.',
    repairInstruction: 'Shorten only this paragraph.'
  };
}

function makeFetch(responses, calls) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const next = responses.shift();
    if (!next) throw new Error(`UNEXPECTED_CALL:${path}`);
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('style BLOCK is repaired before Gemini Critic sees the article', async () => {
  const calls = [];
  const original = article('<p>현대 사회에서 PC 성능의 중요성이 더욱 커지고 있습니다.</p><p>함께 살펴보겠습니다.</p>');
  const repaired = article('<p>PC가 갑자기 느려졌다면 먼저 작업 관리자의 CPU, 메모리, 디스크 사용률을 확인하세요.</p><p>사용률이 계속 높은 항목부터 원인을 좁히면 됩니다.</p>');
  const stages = [];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: original.topic, language: 'ko' },
    makeFetch([
      { article: original },
      { article: repaired },
      { status: 'PASS', score: 98, issues: [] }
    ], calls),
    { onStage: async (stage) => stages.push(stage) }
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.styleRepairApplied, true);
  assert.equal(result.repairApplied, true);
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.article.html, repaired.html);
  assert.equal(result.styleLint.beforeCritic.status, 'BLOCK');
  assert.equal(result.styleLint.final.status, 'PASS');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
  assert.ok(calls[1].body.issues.some((item) => item.code === 'AI_STYLE_CLICHE'));
  assert.deepEqual(calls[2].body.article, repaired);
  assert.deepEqual(stages, ['style_repairing', 'critic_review']);
});

test('production two-attempt cap retries style BLOCK twice before Critic', async () => {
  const calls = [];
  const original = article('<p>현대 사회에서 PC 성능의 중요성이 더욱 커지고 있습니다.</p>');
  const repair1 = article('<p>빠르게 변화하는 시대에 PC 성능의 중요성이 커지고 있습니다.</p>');
  const repair2 = article('<p>PC가 느려졌다면 작업 관리자에서 CPU, 메모리, 디스크 사용률부터 확인하세요.</p>');

  const result = await runNewArticlePipeline(
    { ...env, TARGETED_REPAIR_MAX_ATTEMPTS: '2' },
    { blogId: '11', topic: original.topic, language: 'ko' },
    makeFetch([
      { article: original },
      { article: repair1 },
      { article: repair2 },
      { status: 'PASS', score: 98, issues: [] }
    ], calls)
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.article.html, repair2.html);
  assert.equal(result.styleLint.final.status, 'PASS');
  assert.equal(calls.filter((call) => call.path === '/api/hub/ai/repair').length, 2);
  assert.equal(calls.filter((call) => call.path === '/api/hub/ai/critic').length, 1);
});

test('style lint runs again after Critic Repair and repairs only the newly blocked location', async () => {
  const calls = [];
  const original = article('<p>PC가 느려졌다면 작업 관리자를 열어 높은 사용률 항목부터 확인하세요.</p>');
  const criticRepairedButAiLike = article('<p>현대 사회에서 PC 상태를 확인하는 것이 중요합니다. 함께 살펴보겠습니다.</p>');
  const styleRepaired = article('<p>작업 관리자에서 CPU, 메모리, 디스크 사용률을 확인한 뒤 계속 높은 항목의 원인을 좁히세요.</p>');
  const stages = [];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: original.topic, language: 'ko' },
    makeFetch([
      { article: original },
      { status: 'FAIL', score: 90, issues: [criticIssue()] },
      { article: criticRepairedButAiLike },
      { article: styleRepaired },
      { status: 'PASS', score: 99, issues: [] }
    ], calls),
    { onStage: async (stage) => stages.push(stage) }
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.article.html, styleRepaired.html);
  assert.equal(result.styleRepairApplied, true);
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.styleLint.afterCriticRepair.status, 'BLOCK');
  assert.equal(result.styleLint.final.status, 'PASS');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
  assert.deepEqual(stages, ['critic_review', 'repairing', 'style_repairing', 'final_critic']);
});
