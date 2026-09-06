import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pipeline = fs.readFileSync('worker/lib/pipeline.js', 'utf8');
const runner = fs.readFileSync('worker/lib/job-runner.js', 'utf8');
const stored = fs.readFileSync('worker/lib/stored-job-executor.js', 'utf8');
const aiRoutes = fs.readFileSync('api-hub-v2/src/lib/ai-routes.js', 'utf8');

test('existing repair starts with a fresh Writer rewrite and preserves Blogger identity for update', () => {
  assert.match(pipeline, /async function rewriteExistingArticle/);
  assert.match(pipeline, /emitStage\(hooks, 'writing'\)/);
  assert.match(pipeline, /rewriteExisting: true/);
  assert.match(pipeline, /rewriteSource/);
  assert.match(pipeline, /preserve: \['blogId', 'bloggerPostId', 'permalink'\]/);
  assert.match(pipeline, /status: 'READY_TO_UPDATE_EXISTING'/);
  assert.match(pipeline, /rewriteMode: 'full_article_same_post_id'/);
  assert.doesNotMatch(pipeline, /status: evaluation\.repairApplied \? 'READY_TO_UPDATE_EXISTING' : 'NO_CHANGE_NEEDED'/);
  assert.match(stored, /function resumesAtCritic/);
  assert.match(stored, /rewriteMode === EXISTING_REWRITE_MODE/);
  assert.match(stored, /const initial = resumesAtCritic\(job\) \? 'critic_review' : 'writing'/);
});

test('legacy Critic continuations are upgraded to full rewrite instead of reusing patch-first prose', () => {
  assert.match(runner, /function isExistingRewriteContinuation/);
  assert.match(runner, /resumeResult\?\.rewriteMode === EXISTING_REWRITE_MODE/);
  assert.match(runner, /if \(isExistingRewriteContinuation\(job\)\)/);
  assert.match(runner, /const sourcePost = await fetchExistingBloggerPost/);
  assert.match(runner, /return runExistingRepairPipeline\(env, sourcePost/);
});

test('existing rewrite sends only compact source metadata instead of copying the old HTML into Writer', () => {
  const helperStart = pipeline.indexOf('async function rewriteExistingArticle');
  const helperEnd = pipeline.indexOf('export async function runExistingRepairPipeline');
  const helper = pipeline.slice(helperStart, helperEnd);
  assert.match(helper, /title: sourceArticle\.title/);
  assert.match(helper, /topic: sourceArticle\.topic/);
  assert.match(helper, /searchDescription: sourceArticle\.searchDescription/);
  assert.match(helper, /labels: sourceArticle\.labels/);
  assert.doesNotMatch(helper, /html: sourceArticle\.html/);
});

test('Writer has an explicit existing-post full rewrite contract with only modest title changes', () => {
  assert.match(aiRoutes, /When rewriteExisting is true/);
  assert.match(aiRoutes, /Rewrite the entire body from scratch/);
  assert.match(aiRoutes, /title may be improved modestly/);
  assert.match(aiRoutes, /caller preserves the existing post identity/);
  assert.match(aiRoutes, /rewriteExisting: input\?\.rewriteExisting === true/);
  assert.match(aiRoutes, /rewriteSource: input\.rewriteSource/);
});