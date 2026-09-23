import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runWorkersAi } from '../src/lib/cloudflare-ai.js';
import { critic, diagnostic, repair, writer } from '../src/lib/ai-routes.js';

function aiMock(handler) {
  return {
    async run(model, body) {
      return handler(model, body);
    }
  };
}

function criticWorkersAi(payload) {
  return aiMock(() => ({ response: JSON.stringify(payload) }));
}

function geminiMustNotRun() {
  return async () => { throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

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

test('AI routes use the full integrated Master v4.5 with role adapters, critic now on Workers AI only', async () => {
  const workersSeen = [];
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
    if (system.includes('MASTER V4.5 COMPLIANCE CRITIC ADAPTER')) {
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
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
    { CRITIC_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: { title: 'Test' }, stage: 'initial', sourcePost: { bloggerPostId: '123' } },
    binding,
    async () => { throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); }
  );
  const repairResult = await repair(
    { REPAIR_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: { title: 'Test' }, issues: [{ code: 'TEST' }] },
    binding
  );

  assert.equal(workersSeen.length, 4);
  assert.equal(workersSeen[0].body.max_tokens, 256);
  assert.equal(workersSeen[1].body.max_tokens, 12288);
  assert.equal(workersSeen[2].body.max_tokens, 12288);
  assert.equal(workersSeen[3].body.max_tokens, 12288);
  assert.equal(workersSeen[3].body.response_format, undefined);

  const writerPromptBytes = utf8Bytes(workersSeen[1].body.messages[0].content);
  const criticPromptBytes = utf8Bytes(workersSeen[2].body.messages[0].content);
  const repairPromptBytes = utf8Bytes(workersSeen[3].body.messages[0].content);
  assert.ok(writerPromptBytes > 93282);
  assert.ok(criticPromptBytes > 93282);
  assert.ok(repairPromptBytes > 93282);

  assert.equal(writerResult.provider, 'cloudflare-workers-ai');
  assert.equal(writerResult.fallbackUsed, false);
  assert.equal(writerResult.rolePrompt.size, 93282);
  assert.equal(writerResult.rolePrompt.sha256, '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66');

  const criticUserText = workersSeen[2].body.messages[1].content;
  const criticPayload = JSON.parse(criticUserText);
  assert.deepEqual(criticPayload.article, { title: 'Test' });
  // The critic is handed the length rather than asked to estimate it; an article with no body
  // measures zero and is below any floor, which is the correct reading of an empty article.
  assert.equal(criticPayload.measuredLength.chars, 0);
  assert.equal(criticPayload.measuredLength.belowFloor, true);
  assert.ok(!criticUserText.includes('initial'));
  assert.ok(!criticUserText.includes('bloggerPostId'));
  assert.match(workersSeen[2].body.messages[0].content, /MASTER V4\.5 COMPLIANCE CRITIC ADAPTER/);
  assert.match(workersSeen[2].body.messages[0].content, /Run the audit as separate passes/);
  assert.match(workersSeen[2].body.messages[0].content, /A distinct repair action must receive a distinct issue/);
  assert.equal(criticResult.auditMode, 'master-v4.5-role-critic-free-ai-granular');
  assert.equal(criticResult.masterV45.size, 93282);
  assert.equal(criticResult.rolePrompt.size, 93282);
  assert.equal(criticResult.provider, 'cloudflare-workers-ai');
  assert.equal(criticResult.fallbackUsed, false);

  assert.match(workersSeen[3].body.messages[0].content, /MASTER V4\.5 TARGETED REPAIR ADAPTER/);
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
  const binding = aiMock((model, body) => {
    modelInputs.push(body.messages[1].content);
    return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
  });

  await critic({}, { article, stage: 'initial' }, binding, geminiMustNotRun());
  await critic({}, { article, stage: 'final', sourcePost: { bloggerPostId: '999' } }, binding, geminiMustNotRun());

  assert.equal(modelInputs.length, 2);
  assert.equal(modelInputs[0], modelInputs[1]);
  // measuredLength is derived from the article alone, so it cannot differ between the stages
  // either -- which is exactly the property this test protects.
  const payload = JSON.parse(modelInputs[0]);
  assert.deepEqual(payload.article, article);
  assert.equal(payload.measuredLength.chars, 'Same body.'.length);
  assert.deepEqual(Object.keys(payload).sort(), ['article', 'measuredLength']);
});

test('critic normalizes PASS with issues into FAIL so repair can run', async () => {
  const result = await critic(
    {},
    { article: { title: 'Test' } },
    criticWorkersAi({
      status: 'PASS',
      score: 93,
      issues: [{
        code: 'READABILITY',
        severity: 'LOW',
        location: 'body',
        reason: 'One sentence is dense.',
        repairInstruction: 'Shorten the sentence.'
      }]
    }),
    geminiMustNotRun()
  );

  assert.equal(result.status, 'FAIL');
  assert.equal(result.issues.length, 1);
  assert.equal(result.contractNormalized, 'PASS_WITH_ISSUES_TO_FAIL');
});

test('critic normalizes PASS without an issues array to an empty issues array', async () => {
  const result = await critic(
    {},
    { article: { title: 'Test' } },
    criticWorkersAi({ status: 'PASS', score: 100 }),
    geminiMustNotRun()
  );

  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.issues, []);
});

test('critic rejects PASS below the 95-point publication threshold', async () => {
  await assert.rejects(
    () => critic(
      {},
      { article: { title: 'Test' } },
      criticWorkersAi({ status: 'PASS', score: 94, issues: [] }),
      geminiMustNotRun()
    ),
    /CRITIC_PASS_SCORE_BELOW_THRESHOLD/
  );
});

test('critic rejects malformed issue details instead of silently accepting a weak audit', async () => {
  await assert.rejects(
    () => critic(
      {},
      { article: { title: 'Test' } },
      criticWorkersAi({
        status: 'FAIL',
        score: 90,
        issues: [{ code: 'VAGUE', severity: 'LOW', location: '', reason: 'Too vague.', repairInstruction: 'Fix it.' }]
      }),
      geminiMustNotRun()
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

// The writer was first shown no band at all, then shown one and asked to estimate its own draft
// against it. Neither worked: four fresh articles on 2026-09-21 came in at 814, 976, 1,085 and
// 1,492 words against a 1,500-2,500 band, and smileinfo.net went on to publish 33 posts at a
// median of 873. A model cannot count its own output, so it is no longer asked to -- the target
// arrives as a character count computed in code, and the finished article is measured the same
// way.
test('the writer is given a counted length target, not asked to estimate one', async () => {
  const source = await readFile(new URL('../src/lib/ai-routes.js', import.meta.url), 'utf8');
  const writerAdapter = source.slice(source.indexOf('CONTENT COMPLETENESS GATE'), source.indexOf('ARTICLE LENGTH PASS'));
  assert.match(writerAdapter, /lengthContract gives you the length this article is planned for, already counted for you in characters/);
  assert.match(writerAdapter, /floorChars is the minimum the finished body must reach/);
  assert.match(writerAdapter, /The same count is measured in code after you return/);
  assert.doesNotMatch(writerAdapter, /estimate your draft's visible word count/i);
  // Padding must still be forbidden, in both prompts.
  assert.match(writerAdapter, /[Nn]ever pad, repeat or restate to reach it/);
  assert.match(writerAdapter, /Do not pad to reach a word count/);
  // The "a genuinely complete short draft is correct, return it as is" escape is deliberately
  // gone. It was the clause the 873-word median lived in: every short draft claims completeness,
  // and nothing could check the claim. Padding is still forbidden and still called the worse
  // failure, so the writer's way out is to add real substance, not filler -- and if it truly
  // cannot, the critic flags it, repair tries, and the article publishes anyway. Nothing holds.
  assert.doesNotMatch(writerAdapter, /must be returned as is/);
  assert.match(writerAdapter, /reaching the floor with filler is a worse failure than falling short/);
  // The contradictory clause is gone: the writer is no longer told to ignore word count outright.
  assert.doesNotMatch(writerAdapter, /Never force keyword density, fixed word count/);
});
