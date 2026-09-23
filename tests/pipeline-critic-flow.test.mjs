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

function coreIssue(location, reason) {
  return {
    code: 'CORE_INFORMATION_MISSING',
    severity: 'HIGH',
    location,
    reason,
    repairInstruction: 'Add the missing decision information.'
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

test('new article pipeline carries the writer\'s attractionImages into the READY result for the image stage to use', async () => {
  const calls = [];
  const responses = [
    { article: article(), attractionImages: ['https://tour.example/a.jpg', 'https://tour.example/b.jpg'] },
    { status: 'PASS', score: 97, issues: [] }
  ];

  const result = await runNewArticlePipeline(
    env,
    { blogId: 'smileatlas', tourApiContentId: '126508', language: 'en' },
    makeFetch(responses, calls)
  );

  assert.equal(result.status, 'READY');
  assert.deepEqual(result.attractionImages, ['https://tour.example/a.jpg', 'https://tour.example/b.jpg']);
});

test('new article pipeline never invents an attractionImages field when the writer did not report one', async () => {
  const calls = [];
  const responses = [
    { article: article() },
    { status: 'PASS', score: 97, issues: [] }
  ];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch(responses, calls)
  );

  assert.equal('attractionImages' in result, false);
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

test('new article pipeline reports per-round critic issue and repair word-count meta via onStage', async () => {
  const calls = [];
  const original = article('<p>Dense original with plenty of words in it.</p>');
  const repaired = article('<p>Short.</p>');
  const responses = [
    { article: original },
    { status: 'FAIL', score: 90, issues: [issue()] },
    { article: repaired },
    { status: 'PASS', score: 98, issues: [] }
  ];
  const rounds = [];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch(responses, calls),
    { onStage: async (stage, meta) => rounds.push({ stage, meta: meta ?? null }) }
  );

  assert.equal(result.status, 'READY');
  assert.deepEqual(rounds.map((round) => round.stage), ['critic_review', 'repairing', 'final_critic']);

  assert.equal(rounds[0].meta, null);

  assert.equal(rounds[1].meta.criticStatus, 'FAIL');
  assert.equal(rounds[1].meta.criticProvider, null);
  assert.equal(rounds[1].meta.criticScore, 90);
  assert.equal(rounds[1].meta.issueCount, 1);
  assert.deepEqual(rounds[1].meta.issueLocations, ['html p 1']);

  assert.equal(rounds[2].meta.repairAttempt, 1);
  assert.equal(rounds[2].meta.repairIssueCount, 1);
  assert.ok(rounds[2].meta.wordCountBefore > rounds[2].meta.wordCountAfter);
});

test('new article pipeline threads the critic\'s actual provider (e.g. free-ai vs cloudflare-workers-ai) into the onStage meta', async () => {
  const calls = [];
  const original = article('<p>Dense original.</p>');
  const repaired = article('<p>Short repaired answer.</p>');
  const responses = [
    { article: original },
    { status: 'FAIL', score: 90, issues: [issue()], provider: 'free-ai' },
    { article: repaired },
    { status: 'PASS', score: 98, issues: [] }
  ];
  const rounds = [];

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch(responses, calls),
    { onStage: async (stage, meta) => rounds.push({ stage, meta: meta ?? null }) }
  );

  assert.equal(result.status, 'READY');
  assert.equal(rounds[1].meta.criticProvider, 'free-ai');
});

test('core information gaps no longer trigger a rewrite; the article finishes and keeps them as advice', async () => {
  const calls = [];
  const first = article('<p>Generic answer.</p><p>More generic advice.</p>');

  const result = await runNewArticlePipeline(
    env,
    { blogId: '11', topic: 'threshold repair', language: 'en', seoBrief: { planning: { recommendedDepth: 'deep-dive' } } },
    makeFetch([
      { article: first },
      {
        status: 'FAIL',
        score: 78,
        issues: [
          coreIssue('html p 1', 'Repair-versus-replace criteria are missing.'),
          coreIssue('html p 2', 'Stop conditions and failure signals are missing.')
        ]
      }
    ], calls)
  );

  // Replanning made articles worse -- job 154 came back from one 1,604 words shorter -- and a
  // second candidate is a second full set of paid calls for a verdict the critic will repeat.
  assert.equal(result.status, 'READY');
  assert.notEqual(result.candidateRegenerated, true);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic'
  ]);
  // What the critic found is not thrown away; it rides along with the finished article.
  assert.equal(result.advisoryReview.haltedOn, 'MASTER_REPLAN_REQUIRED');
  assert.equal(result.advisoryReview.criticStatus, 'FAIL');
  assert.equal(result.advisoryReview.issues.length, 2);
  // A READY result carries no reviewReason at all -- there is nothing left for a person to do.
  assert.equal('reviewReason' in result, false);
});

test('the flagged location is repaired, then the article finishes with the verdict attached', async () => {
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

  // Repair still runs its full budget; what changed is where an unsatisfied critic lands.
  assert.equal(result.status, 'READY');
  assert.equal(result.repairAttempts, 2);
  assert.equal(result.finalCritic.status, 'FAIL');
  assert.equal(result.advisoryReview.haltedOn, 'CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS');
  assert.equal(result.advisoryReview.criticScore, 92);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/writer',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
});

test('a second candidate is not written once targeted repairs are exhausted', async () => {
  const calls = [];
  const first = article('<p>First candidate problem.</p>');
  const firstRepair = article('<p>First candidate still weak.</p>');
  const secondRepair = article('<p>First candidate still failing.</p>');
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
      { status: 'FAIL', score: 90, issues: [issue()] }
    ], calls)
  );

  assert.equal(result.status, 'READY');
  assert.equal(calls.filter((call) => call.path === '/api/hub/ai/writer').length, 1);
  assert.equal(result.advisoryReview.criticScore, 90);
});

// The safety property of the inversion: the critic advises, but the deterministic gate still
// has an absolute veto over anything code can actually verify.
test('a deterministic block still stops the article from reaching READY', async () => {
  const calls = [];
  const withPlaceholder = article('<p>Cost is [insert price here] per unit.</p>');
  const limitedEnv = { ...env, TARGETED_REPAIR_MAX_ATTEMPTS: '2', NEW_ARTICLE_MAX_CANDIDATES: '1' };

  const result = await runNewArticlePipeline(
    limitedEnv,
    { blogId: '11', topic: 'test topic', language: 'en' },
    makeFetch([
      { article: withPlaceholder },
      { status: 'FAIL', score: 90, issues: [issue()] },
      { article: withPlaceholder },
      { status: 'FAIL', score: 90, issues: [issue()] },
      { article: withPlaceholder },
      { status: 'FAIL', score: 90, issues: [issue()] }
    ], calls)
  );

  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.reviewReason, 'DETERMINISTIC_QA_BLOCKED');
  assert.equal(result.deterministicQa.status, 'BLOCK');
});
