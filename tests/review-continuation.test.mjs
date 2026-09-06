import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runNewArticleContinuationPipeline
} from '../worker/lib/pipeline.js';
import { executeJob } from '../worker/lib/job-runner.js';
import { processStoredJob } from '../worker/lib/stored-job-executor.js';

const env = {
  API_HUB_BASE_URL: 'https://hub.example.test',
  HUB_API_KEY: 'test-key',
  TARGETED_REPAIR_MAX_ATTEMPTS: '2'
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
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const next = responses.shift();
    if (!next) throw new Error(`UNEXPECTED_CALL:${path}`);
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('review continuation repairs the last saved article instead of calling Writer again', async () => {
  const calls = [];
  const stages = [];
  const prior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Still too dense.</p>'),
    repairApplied: true,
    repairAttempts: 2,
    finalCritic: { status: 'FAIL', score: 91, issues: [issue()] },
    candidateAttempt: 2,
    candidateRegenerated: true,
    candidateHistory: [{ candidateAttempt: 2, status: 'FAIL' }]
  };

  const result = await runNewArticleContinuationPipeline(
    env,
    prior,
    makeFetch([
      { status: 'FAIL', score: 91, issues: [issue()] },
      { article: article('<p>Concise final answer.</p>') },
      { status: 'PASS', score: 98, issues: [] }
    ], calls),
    { onStage: async (stage) => stages.push(stage) }
  );

  assert.equal(result.status, 'READY');
  assert.equal(result.article.html, '<p>Concise final answer.</p>');
  assert.equal(result.continuationAttempt, 1);
  assert.equal(result.candidateAttempt, 2);
  assert.equal(result.totalRepairAttempts, 3);
  assert.equal(result.repairStrategy, 'targeted_sections_rewrite');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/hub/ai/critic',
    '/api/hub/ai/repair',
    '/api/hub/ai/critic'
  ]);
  assert.equal(calls.some((call) => call.path === '/api/hub/ai/writer'), false);
  assert.equal(calls[1].body.strategy, 'targeted_sections_rewrite');
  assert.match(calls[1].body.issues[0].repairInstruction, /same defect survived|entire exact flagged block/i);
  assert.deepEqual(stages, ['critic_review', 'repairing', 'final_critic']);
});

test('full-rewrite existing-post continuation does not refetch the original Blogger post', async () => {
  const calls = [];
  const prior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Already rewritten draft.</p>'),
    identity: {
      blogId: 'b1',
      bloggerPostId: 'p1',
      permalink: 'https://example.com/p1'
    },
    rewriteApplied: true,
    rewriteMode: 'full_article_same_post_id',
    repairApplied: true,
    repairAttempts: 3
  };

  const result = await executeJob(
    env,
    {
      mode: 'repair_existing',
      blogId: 'b1',
      bloggerPostId: 'p1',
      recoveryCode: 'CRITIC_REVIEW_CONTINUE',
      resumeResult: prior
    },
    makeFetch([
      { status: 'PASS', score: 98, issues: [] }
    ], calls)
  );

  assert.equal(result.status, 'READY_TO_UPDATE_EXISTING');
  assert.equal(result.identity.bloggerPostId, 'p1');
  assert.equal(result.repairStrategy, 'targeted_sections_rewrite');
  assert.deepEqual(calls.map((call) => call.path), ['/api/hub/ai/critic']);
  assert.equal(calls.some((call) => call.path === '/api/blogger/post/get'), false);
});

test('legacy existing-post continuation refetches same Blogger post and starts a fresh full rewrite', async () => {
  const calls = [];
  const prior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Legacy patch-first draft.</p>'),
    identity: {
      blogId: 'b1',
      bloggerPostId: 'p1',
      permalink: 'https://example.com/p1'
    },
    repairApplied: true,
    repairAttempts: 3
  };
  const rewritten = {
    ...article('<p>Fresh complete rewrite for the same existing post.</p>'),
    title: 'Test article updated'
  };

  const result = await executeJob(
    env,
    {
      mode: 'repair_existing',
      blogId: 'b1',
      bloggerPostId: 'p1',
      targetUrl: 'https://example.com/p1',
      recoveryCode: 'CRITIC_REVIEW_CONTINUE',
      resumeResult: prior
    },
    makeFetch([
      { blogId: 'b1', bloggerPostId: 'p1', permalink: 'https://example.com/p1', article: article('<p>Current Blogger source.</p>') },
      { article: rewritten },
      { status: 'PASS', score: 98, issues: [] }
    ], calls)
  );

  assert.equal(result.status, 'READY_TO_UPDATE_EXISTING');
  assert.equal(result.identity.bloggerPostId, 'p1');
  assert.equal(result.rewriteMode, 'full_article_same_post_id');
  assert.equal(result.article.title, 'Test article updated');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/blogger/post/get',
    '/api/hub/ai/writer',
    '/api/hub/ai/critic'
  ]);
  assert.equal(calls[1].body.rewriteExisting, true);
  assert.equal(calls[1].body.rewriteSource.title, 'Test article');
  assert.equal(Object.hasOwn(calls[1].body.rewriteSource, 'html'), false);
});

test('stored legacy existing repair continuation starts at writing, while rewritten continuation resumes at Critic', async () => {
  const legacyStates = [];
  const legacyCalls = [];
  const legacyPrior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Legacy candidate.</p>'),
    identity: { blogId: 'b1', bloggerPostId: 'p1', permalink: 'https://example.com/p1' }
  };
  const rewritten = article('<p>Fresh rewritten body.</p>');

  const legacyOut = await processStoredJob(
    env,
    {
      id: 78,
      mode: 'repair_existing',
      status: 'queued',
      blog_id: 'b1',
      blogger_post_id: 'p1',
      target_url: 'https://example.com/p1',
      payload_json: '{}',
      result_json: JSON.stringify(legacyPrior),
      last_error_code: 'CRITIC_REVIEW_CONTINUE'
    },
    {
      fetchImpl: makeFetch([
        { blogId: 'b1', bloggerPostId: 'p1', permalink: 'https://example.com/p1', article: article('<p>Current source.</p>') },
        { article: rewritten },
        { status: 'PASS', score: 98, issues: [] }
      ], legacyCalls),
      saveState: async (state) => legacyStates.push(state)
    }
  );

  assert.equal(legacyOut.state, 'ready');
  assert.deepEqual(legacyStates, ['writing', 'critic_review', 'ready']);

  const resumedStates = [];
  const resumedCalls = [];
  const rewrittenPrior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Already full rewritten candidate.</p>'),
    identity: { blogId: 'b1', bloggerPostId: 'p1', permalink: 'https://example.com/p1' },
    rewriteMode: 'full_article_same_post_id'
  };
  const resumedOut = await processStoredJob(
    env,
    {
      id: 79,
      mode: 'repair_existing',
      status: 'queued',
      blog_id: 'b1',
      blogger_post_id: 'p1',
      payload_json: '{}',
      result_json: JSON.stringify(rewrittenPrior),
      last_error_code: 'CRITIC_REVIEW_CONTINUE'
    },
    {
      fetchImpl: makeFetch([
        { status: 'PASS', score: 99, issues: [] }
      ], resumedCalls),
      saveState: async (state) => resumedStates.push(state)
    }
  );

  assert.equal(resumedOut.state, 'ready');
  assert.deepEqual(resumedStates, ['critic_review', 'ready']);
  assert.deepEqual(resumedCalls.map((call) => call.path), ['/api/hub/ai/critic']);
});

test('stored new-article review continuation still starts at Critic and reuses result_json', async () => {
  const states = [];
  const calls = [];
  const prior = {
    status: 'NEEDS_REVIEW',
    article: article('<p>Saved repaired candidate.</p>'),
    repairApplied: true,
    repairAttempts: 3,
    candidateAttempt: 1
  };

  const out = await processStoredJob(
    env,
    {
      id: 77,
      mode: 'new_article',
      status: 'queued',
      blog_id: 'b1',
      topic: 'test topic',
      payload_json: '{"language":"en"}',
      result_json: JSON.stringify(prior),
      last_error_code: 'CRITIC_REVIEW_CONTINUE'
    },
    {
      fetchImpl: makeFetch([
        { status: 'PASS', score: 99, issues: [] }
      ], calls),
      saveState: async (state) => states.push(state)
    }
  );

  assert.equal(out.state, 'ready');
  assert.deepEqual(states, ['critic_review', 'ready']);
  assert.deepEqual(calls.map((call) => call.path), ['/api/hub/ai/critic']);
});

test('auto rescue keeps Critic continuation immediate, bounded, and separate from infra retries', () => {
  const source = fs.readFileSync('worker/lib/job-auto-rescue.js', 'utf8');
  assert.match(source, /CRITIC_REVIEW_CONTINUE/);
  assert.match(source, /CRITIC_REVIEW_RETRY/);
  assert.match(source, /MAX_REVIEW_CONTINUATIONS/);
  assert.match(source, /result_json IS NOT NULL/);
  assert.match(source, /action: Number\(result\?\.meta\?\.changes \|\| 0\) === 1 \? 'revived'/);
  assert.match(source, /retry_count = 0/);
  assert.match(source, /isReviewContinuationRetry/);
});