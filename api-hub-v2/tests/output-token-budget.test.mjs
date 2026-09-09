import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkersAi } from '../src/lib/cloudflare-ai.js';
import { critic, diagnostic, repair, writer } from '../src/lib/ai-routes.js';

function aiMock(handler) {
  return {
    async run(model, body) {
      return handler(model, body);
    }
  };
}

function noWorkers() {
  return aiMock(() => {
    throw new Error('WORKERS_AI_MUST_NOT_RUN_FOR_CRITIC');
  });
}

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

const GEMINI_ENV = Object.freeze({
  GEMINI_API_KEY: 'test-key',
  GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite'
});

test('runWorkersAi maps token, reasoning, response-format, and deterministic sampling controls correctly', async () => {
  const seen = [];
  const binding = aiMock((model, body) => {
    seen.push({ model, body });
    return { response: 'OK' };
  });

  await runWorkersAi({}, {
    model: '@cf/openai/gpt-oss-120b',
    prompt: 'test',
    maxTokens: 4096
  }, binding);
  await runWorkersAi({}, {
    model: '@cf/zai-org/glm-4.7-flash',
    prompt: 'test',
    maxCompletionTokens: 4096,
    reasoningEffort: null,
    chatTemplateKwargs: { enable_thinking: false },
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      }
    },
    temperature: 0,
    seed: 4501
  }, binding);

  assert.equal(seen[0].body.max_tokens, 4096);
  assert.equal(seen[0].body.max_completion_tokens, undefined);
  assert.equal(seen[1].body.max_tokens, undefined);
  assert.equal(seen[1].body.max_completion_tokens, 4096);
  assert.equal(seen[1].body.reasoning_effort, null);
  assert.deepEqual(seen[1].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(seen[1].body.response_format.type, 'json_schema');
  assert.deepEqual(seen[1].body.response_format.json_schema.required, ['ok']);
  assert.equal(seen[1].body.temperature, 0);
  assert.equal(seen[1].body.seed, 4501);
});

test('runWorkersAi serializes structured response objects for existing JSON parsers', async () => {
  const result = await runWorkersAi({}, {
    model: '@cf/zai-org/glm-4.7-flash',
    prompt: 'test',
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status']
      }
    }
  }, aiMock(() => ({ response: { status: 'PASS' } })));

  assert.equal(result.response, '{"status":"PASS"}');
});

test('AI routes use the full integrated Master v4.5 with role adapters and dedicated Gemini granular critic', async () => {
  const workersSeen = [];
  let geminiBody = null;
  const binding = aiMock((model, body) => {
    workersSeen.push({ model, body });
    const system = body.messages?.[0]?.content || '';
    if (body.messages?.length === 1) return { response: 'OK' };
    if (system.includes('AUTOMATION WRITER ADAPTER')) {
      return {
        response: JSON.stringify({
          article: {
            title: 'Test',
            html: '<p>Answer.</p>',
            searchDescription: 'Answer.',
            labels: [],
            sources: [],
            language: 'en',
            topic: 'test topic'
          }
        })
      };
    }
    if (system.includes('targeted repair editor')) {
      return {
        response: JSON.stringify({
          title: 'Test',
          html: '<p>Answer.</p>',
          searchDescription: 'Answer.',
          labels: [],
          sources: [],
          language: 'en',
          topic: 'test topic'
        })
      };
    }
    throw new Error('unexpected Workers AI call');
  });

  await diagnostic({ WRITER_MODEL: '@cf/openai/gpt-oss-120b' }, binding);
  const writerResult = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    { blogId: '11', topic: 'test topic', language: 'en' },
    binding
  );
  const criticResult = await critic(
    GEMINI_ENV,
    { article: { title: 'Test' }, stage: 'initial', sourcePost: { bloggerPostId: '123' } },
    binding,
    async (url, init) => {
      geminiBody = JSON.parse(init.body);
      return geminiResponse(JSON.stringify({ status: 'PASS', score: 100, issues: [] }));
    }
  );
  const repairResult = await repair(
    { REPAIR_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: { title: 'Test' }, issues: [{ code: 'TEST' }] },
    binding
  );

  assert.equal(workersSeen.length, 3);
  assert.equal(workersSeen[0].body.max_tokens, 256);
  assert.equal(workersSeen[1].body.max_tokens, 12288);
  assert.equal(workersSeen[2].body.max_tokens, 12288);
  assert.equal(workersSeen[2].body.response_format, undefined);

  const writerPromptBytes = utf8Bytes(workersSeen[1].body.messages[0].content);
  const criticPromptBytes = utf8Bytes(geminiBody.systemInstruction.parts[0].text);
  const repairPromptBytes = utf8Bytes(workersSeen[2].body.messages[0].content);
  assert.ok(writerPromptBytes > 93282);
  assert.ok(criticPromptBytes > 93282);
  assert.ok(repairPromptBytes > 93282);

  assert.equal(writerResult.provider, 'cloudflare-workers-ai');
  assert.equal(writerResult.fallbackUsed, false);
  assert.equal(writerResult.rolePrompt.size, 93282);
  assert.equal(writerResult.rolePrompt.sha256, '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66');

  assert.equal(geminiBody.generationConfig.maxOutputTokens, 12288);
  assert.equal(geminiBody.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(geminiBody.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(geminiBody.generationConfig.responseSchema.required, ['status', 'score', 'issues']);
  assert.deepEqual(
    geminiBody.generationConfig.responseSchema.properties.issues.items.required,
    ['code', 'severity', 'location', 'reason', 'repairInstruction']
  );
  assert.deepEqual(JSON.parse(geminiBody.contents[0].parts[0].text), { article: { title: 'Test' } });
  assert.ok(!geminiBody.contents[0].parts[0].text.includes('initial'));
  assert.ok(!geminiBody.contents[0].parts[0].text.includes('bloggerPostId'));
  assert.match(geminiBody.systemInstruction.parts[0].text, /MASTER V4\.5 COMPLIANCE CRITIC ADAPTER/);
  assert.match(geminiBody.systemInstruction.parts[0].text, /Run the audit as separate passes/);
  assert.match(geminiBody.systemInstruction.parts[0].text, /A distinct repair action must receive a distinct issue/);
  assert.equal(criticResult.auditMode, 'master-v4.5-role-critic-gemini-granular');
  assert.equal(criticResult.masterV45.size, 93282);
  assert.equal(criticResult.rolePrompt.size, 93282);
  assert.equal(criticResult.provider, 'google-gemini');
  assert.equal(criticResult.fallbackUsed, false);

  assert.match(workersSeen[2].body.messages[0].content, /MASTER V4\.5 TARGETED REPAIR ADAPTER/);
  assert.equal(repairResult.repairMode, 'master-v4.5-role-targeted');
  assert.equal(repairResult.masterV45.size, 93282);
  assert.equal(repairResult.rolePrompt.size, 93282);
  assert.equal(repairResult.provider, 'cloudflare-workers-ai');
  assert.equal(repairResult.fallbackUsed, false);
});

test('critic model-facing input is identical across initial/final stage labels for the same article', async () => {
  const modelInputs = [];
  const article = {
    title: 'Same article',
    html: '<p>Same body.</p>',
    searchDescription: 'Same description.',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'same topic'
  };
  const fetchMock = async (url, init) => {
    modelInputs.push(JSON.parse(init.body).contents[0].parts[0].text);
    return geminiResponse(JSON.stringify({ status: 'PASS', score: 100, issues: [] }));
  };

  await critic(GEMINI_ENV, { article, stage: 'initial' }, noWorkers(), fetchMock);
  await critic(GEMINI_ENV, { article, stage: 'final', sourcePost: { bloggerPostId: '999' } }, noWorkers(), fetchMock);

  assert.equal(modelInputs.length, 2);
  assert.equal(modelInputs[0], modelInputs[1]);
  assert.deepEqual(JSON.parse(modelInputs[0]), { article });
});

test('critic normalizes PASS with issues into FAIL so repair can run', async () => {
  const result = await critic(
    GEMINI_ENV,
    { article: { title: 'Test' } },
    noWorkers(),
    async () => geminiResponse(JSON.stringify({
      status: 'PASS',
      score: 93,
      issues: [{
        code: 'READABILITY',
        severity: 'LOW',
        location: 'body',
        reason: 'One sentence is dense.',
        repairInstruction: 'Shorten the sentence.'
      }]
    }))
  );

  assert.equal(result.status, 'FAIL');
  assert.equal(result.issues.length, 1);
  assert.equal(result.contractNormalized, 'PASS_WITH_ISSUES_TO_FAIL');
});

test('critic normalizes PASS without an issues array to an empty issues array', async () => {
  const result = await critic(
    GEMINI_ENV,
    { article: { title: 'Test' } },
    noWorkers(),
    async () => geminiResponse(JSON.stringify({ status: 'PASS', score: 100 }))
  );

  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.issues, []);
});

test('critic rejects PASS below the 95-point publication threshold', async () => {
  await assert.rejects(
    () => critic(
      GEMINI_ENV,
      { article: { title: 'Test' } },
      noWorkers(),
      async () => geminiResponse(JSON.stringify({ status: 'PASS', score: 94, issues: [] }))
    ),
    /CRITIC_PASS_SCORE_BELOW_THRESHOLD/
  );
});

test('critic rejects malformed issue details instead of silently accepting a weak audit', async () => {
  await assert.rejects(
    () => critic(
      GEMINI_ENV,
      { article: { title: 'Test' } },
      noWorkers(),
      async () => geminiResponse(JSON.stringify({
        status: 'FAIL',
        score: 90,
        issues: [{ code: 'VAGUE', severity: 'LOW', location: '', reason: 'Too vague.', repairInstruction: 'Fix it.' }]
      }))
    ),
    /CRITIC_ISSUE_SCHEMA_INVALID/
  );
});

test('runWorkersAi rejects invalid provider controls before provider use', async () => {
  let called = false;
  const binding = aiMock(() => {
    called = true;
    return { response: 'should not run' };
  });

  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/openai/gpt-oss-120b',
      prompt: 'test',
      maxTokens: 0
    }, binding),
    /MAX_TOKENS_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      maxCompletionTokens: 0
    }, binding),
    /MAX_COMPLETION_TOKENS_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      reasoningEffort: 'extreme'
    }, binding),
    /REASONING_EFFORT_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      chatTemplateKwargs: { enable_thinking: 'no' }
    }, binding),
    /CHAT_TEMPLATE_KWARGS_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      responseFormat: { type: 'json_schema' }
    }, binding),
    /RESPONSE_FORMAT_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      temperature: -0.1
    }, binding),
    /TEMPERATURE_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      temperature: 2.1
    }, binding),
    /TEMPERATURE_INVALID/
  );
  await assert.rejects(
    () => runWorkersAi({}, {
      model: '@cf/zai-org/glm-4.7-flash',
      prompt: 'test',
      seed: 4.5
    }, binding),
    /SEED_INVALID/
  );
  assert.equal(called, false);
});
