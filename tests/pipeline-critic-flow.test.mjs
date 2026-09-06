import test from 'node:test';
import assert from 'node:assert/strict';
import { runNewArticlePipeline } from '../worker/lib/pipeline.js';

const env = {
  API_HUB_BASE_URL: 'https://hub.example.test',
  HUB_API_KEY: 'test-key'
};

function article(html = '<p>Useful answer.</p>') {
  return {
    title: 'Test article',
    html,
    searchDescription: 'Useful answer.',
    labels: ['test'],
    sources: [],
    language: 'en',
    topic: 'test topic'
  };
}

function issue() {
  return {
    code: 'READABILITY',
    severity: 'LOW',
    location: 'html p 1',
    reason: 'Sentence is too dense.',
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

test('new article pipeline stops after initial PASS and does not redundantly re-criticize unchanged article', async () => {
  const calls = [];
  const original = article();
  const responses = [
    { article: original },
    { status: 'PASS', score: 97, issues: [] }
  ];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch(responses, calls)
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.repairApplied, false);
  assert.deepEqual(result.initialCritic, result.finalCritic);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic'
  ]);
  assert.equal(calls[1].body.stage, 'initial');
});

test('new article pipeline runs targeted Repair and re-checks Critic after FAIL', async () => {
  const calls = [];
  const original = article('<p>Dense original.</p>');
  const repaired = article('<p>Short repaired answer.</p>');
  const responses = [
    { article: original },
    { status: 'FAIL', score: 90, issues: [issue()] },
    { article: repaired },
    { status: 'PASS', score: 98, issues: [] }
  ];
  const stages = [];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch(responses, calls),
    { onStage: async (stage) => stages.push(stage) }
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.repairApplied, true);
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.initialCritic.status, 'FAIL');
  assert.equal(result.finalCritic.status, 'PASS');
  assert.equal(result.article.html, repaired.html);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
  assert.equal(calls[2].body.strategy, 'targeted_sections_only');
  assert.equal(calls[2].body.repairAttempt, 1);
  assert.deepEqual(stages, ['critic_review', 'repairing', 'final_critic']);
});

test('new article pipeline retries the currently flagged location before NEEDS_REVIEW', async () => {
  const calls = [];
  const original = article('<p>Problem.</p>');
  const repairedOnce = article('<p>Still problematic.</p>');
  const repairedTwice = article('<p>Still not good enough.</p>');
  const repeatedIssue = { ...issue(), reason: 'The same paragraph remains too dense.' };
  const limitedEnv = {
    ...env,
    TARGETED_REPAIR_MAX_ATTEMPTS: '2',
    NEW_ARTICLE_MAX_CANDIDATES: '1'
  };

  const result = await runNewArticlePipeline(
    limitedEnv,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch([
      { article: original },
      { status: 'FAIL', score: 88, issues: [issue()] },
      { article: repairedOnce },
      { status: 'FAIL', score: 91, issues: [repeatedIssue] },
      { article: repairedTwice },
      { status: 'FAIL', score: 92, issues: [repeatedIssue] }
    ], calls)
  );

  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.reviewReason, 'CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS');
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.finalCritic.status, 'FAIL');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
});

test('new article pipeline regenerates one fresh candidate only after targeted repairs are exhausted', async () => {
  const calls = [];
  const first = article('<p>First candidate problem.</p>');
  const firstRepair = article('<p>First candidate still weak.</p>');
  const secondRepair = article('<p>First candidate still failing.</p>');
  const second = article('<p>Fresh candidate is concise and useful.</p>');
  const limitedEnv = { ...env, TARGETED_REPAIR_MAX_ATTEMPTS: '2' };

  const result = await runNewArticlePipeline(
    limitedEnv,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch([
      { article: first },
      { status: 'FAIL', score: 85, issues: [issue()] },
      { article: firstRepair },
      { status: 'FAIL', score: 89, issues: [issue()] },
      { article: secondRepair },
      { status: 'FAIL', score: 90, issues: [issue()] },
      { article: second },
      { status: 'PASS', score: 98, issues: [] }
    ], calls)
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.candidateRegenerated, true);
  assert.equal(result.candidateAttempt, 2);
  assert.equal(result.candidateHistory.length, 2);
  assert.equal(calls.filter((call) => call.path === '/api/hub/ai/writer').length, 2);
  assert.equal(calls[6].body.candidateAttempt, 2);
  assert.equal(calls[6].body.retryReason, 'CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS');
});
