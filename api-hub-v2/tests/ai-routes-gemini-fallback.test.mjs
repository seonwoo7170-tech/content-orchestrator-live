import test from 'node:test';
import assert from 'node:assert/strict';
import { writer, critic, repair } from '../src/lib/ai-routes.js';

function exhaustedWorkersAi() {
  return {
    async run() {
      const error = new Error('3036 daily free allocation exhausted');
      error.code = 3036;
      throw error;
    }
  };
}

function workersMustNotRun() {
  return {
    async run() {
      throw new Error('WORKERS_AI_MUST_NOT_RUN_FOR_CRITIC');
    }
  };
}

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

const ENV = Object.freeze({
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_WRITER_MODEL: 'gemini-3.5-flash-lite',
  GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite',
  GEMINI_REPAIR_MODEL: 'gemini-3.5-flash-lite'
});

test('writer falls back to Gemini with the verified writer role prompt', async () => {
  let requestBody = null;
  const article = {
    title: '테스트 글',
    html: '<p>핵심 답변입니다.</p>',
    searchDescription: '테스트 설명',
    labels: ['테스트'],
    sources: [],
    language: 'ko',
    topic: '테스트 주제'
  };

  const result = await writer(
    ENV,
    { blogId: '11', topic: '테스트 주제', language: 'ko' },
    exhaustedWorkersAi(),
    async (url, init) => {
      requestBody = JSON.parse(init.body);
      return geminiResponse(JSON.stringify({ article }));
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryError, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(result.rolePrompt.size, 93282);
  assert.equal(result.article.title, '테스트 글');
  assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.match(requestBody.systemInstruction.parts[0].text, /# 91\. 자연스러운 문체 및 자동 생성 흔적 방지/);
  assert.ok(requestBody.systemInstruction.parts[0].text.includes('# 4. 최초 플랫폼 선택'));
});

test('critic uses Gemini only with granular audit instructions, medium thinking and structured output', async () => {
  let requestBody = null;
  const article = {
    title: 'Test',
    html: '<p>Body.</p>',
    searchDescription: 'Description',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'topic'
  };
  const criticPayload = {
    status: 'FAIL',
    score: 90,
    issues: [{
      code: 'READABILITY',
      severity: 'MEDIUM',
      location: 'first paragraph',
      reason: 'The paragraph is too dense.',
      repairInstruction: 'Split it into shorter sentences.'
    }]
  };

  const result = await critic(
    ENV,
    { article, stage: 'initial', sourcePost: { bloggerPostId: 'should-not-leak' } },
    workersMustNotRun(),
    async (url, init) => {
      requestBody = JSON.parse(init.body);
      return geminiResponse(JSON.stringify(criticPayload));
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.primaryError, null);
  assert.equal(result.auditMode, 'master-v4.5-role-critic-gemini-granular');
  assert.equal(result.rolePrompt.size, 93282);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.issues.length, 1);
  assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(requestBody.generationConfig.responseSchema.required, ['status', 'score', 'issues']);
  assert.match(requestBody.systemInstruction.parts[0].text, /Run the audit as separate passes/);
  assert.match(requestBody.systemInstruction.parts[0].text, /A distinct repair action must receive a distinct issue/);
  assert.match(requestBody.systemInstruction.parts[0].text, /misleading or overclaiming searchDescription/);
  const userText = requestBody.contents[0].parts[0].text;
  assert.deepEqual(JSON.parse(userText), { article });
  assert.ok(!userText.includes('initial'));
  assert.ok(!userText.includes('bloggerPostId'));
});

test('critic fails closed when Gemini API key is not configured and never falls back to Workers', async () => {
  let workersCalled = false;
  const binding = {
    async run() {
      workersCalled = true;
      return { response: 'unexpected' };
    }
  };
  await assert.rejects(
    () => critic(
      {},
      { article: { title: 'Test' } },
      binding,
      async () => geminiResponse(JSON.stringify({ status: 'PASS', score: 100, issues: [] }))
    ),
    /GEMINI_API_KEY_REQUIRED/
  );
  assert.equal(workersCalled, false);
});

test('repair falls back to Gemini and preserves targeted repair contract', async () => {
  let requestBody = null;
  const article = {
    title: 'Test',
    html: '<p>Dense sentence.</p>',
    searchDescription: 'Description',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'topic'
  };
  const repaired = { ...article, html: '<p>Short sentence.</p>' };

  const result = await repair(
    ENV,
    {
      article,
      issues: [{
        code: 'READABILITY',
        severity: 'MEDIUM',
        location: 'first paragraph',
        reason: 'Dense.',
        repairInstruction: 'Shorten it.'
      }]
    },
    exhaustedWorkersAi(),
    async (url, init) => {
      requestBody = JSON.parse(init.body);
      return geminiResponse(JSON.stringify(repaired));
    }
  );

  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.repairMode, 'master-v4.5-role-targeted');
  assert.equal(result.rolePrompt.size, 93282);
  assert.equal(result.article.html, '<p>Short sentence.</p>');
  assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(JSON.parse(requestBody.contents[0].parts[0].text).strategy, 'targeted_sections_only');
});
