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

// Critic used to run on Gemini exclusively (with granular audit instructions and
// structured JSON output). Removed at the operator's request -- Gemini's critic issues
// and repairInstructions were suspected of driving repair() to progressively trim long
// articles shorter across successive critic->repair rounds. Critic now runs on Workers
// AI unconditionally and never calls Gemini at all, whether or not a Gemini key is
// configured.
test('critic runs on Workers AI with granular audit instructions, regardless of Gemini configuration', async () => {
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
  const binding = {
    async run(model, body) {
      requestBody = body;
      return { response: JSON.stringify(criticPayload), usage: { total_tokens: 10 } };
    }
  };

  const result = await critic(
    ENV,
    { article, stage: 'initial', sourcePost: { bloggerPostId: 'should-not-leak' } },
    binding,
    async () => { throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); }
  );

  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.primaryError, null);
  assert.equal(result.auditMode, 'master-v4.5-role-critic-free-ai-granular');
  assert.equal(result.rolePrompt.size, 93282);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.issues.length, 1);
  const systemText = requestBody.messages[0].content;
  assert.match(systemText, /Run the audit as separate passes/);
  assert.match(systemText, /A distinct repair action must receive a distinct issue/);
  assert.match(systemText, /misleading or overclaiming searchDescription/);
  assert.match(systemText, /ARTICLE LENGTH PASS/);
  assert.match(systemText, /measuredLength is supplied with the Article and was counted in code, not estimated/);
  assert.match(systemText, /Never emit a length finding on its own with no missing-content reason/);
  const userText = requestBody.messages[1].content;
  const userPayload = JSON.parse(userText);
  assert.deepEqual(userPayload.article, article);
  // Counted here rather than left to the model, which is the whole change.
  assert.equal(typeof userPayload.measuredLength.chars, 'number');
  assert.ok(!userText.includes('initial'));
  assert.ok(!userText.includes('bloggerPostId'));
});

test('critic never calls Gemini even when a Gemini key is configured', async () => {
  let geminiCalled = false;
  const binding = {
    async run() {
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }), usage: { total_tokens: 10 } };
    }
  };
  const result = await critic(
    ENV,
    { article: { title: 'Test', html: '<p>Body.</p>', searchDescription: 'Description', labels: [], sources: [], language: 'en', topic: 'topic' } },
    binding,
    async () => { geminiCalled = true; return geminiResponse(JSON.stringify({ status: 'PASS', score: 100, issues: [] })); }
  );
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(geminiCalled, false);
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
