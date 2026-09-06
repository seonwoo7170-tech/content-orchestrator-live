import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dedupe = fs.readFileSync(new URL('../worker/lib/topic-dedupe.js', import.meta.url), 'utf8');
const automatic = fs.readFileSync(new URL('../worker/lib/daily-auto-work.js', import.meta.url), 'utf8');
const publisher = fs.readFileSync(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
const recovery = fs.readFileSync(new URL('../worker/lib/job-recovery-runner.js', import.meta.url), 'utf8');
const legacy = fs.readFileSync(new URL('../worker/lib/legacy-route-cleanup.js', import.meta.url), 'utf8');

test('topic selection reserves planner topics before materializing and retries duplicate plans', () => {
  assert.match(dedupe, /reservePlannerTopicCandidate/);
  assert.match(dedupe, /status = 'reserved'/);
  assert.match(automatic, /findNewArticleTopicConflict/);
  assert.match(automatic, /reservePlannerTopicCandidate/);
  assert.match(automatic, /rejectDuplicateTopicCandidate/);
  assert.match(automatic, /attempt < 3/);
  assert.match(automatic, /AUTO_WORK_UNIQUE_TOPIC_UNAVAILABLE/);
});

test('ready duplicate cleanup keeps the earlier job and quarantines only later ready jobs', () => {
  assert.match(dedupe, /cleanupReadyDuplicateNewArticles/);
  assert.match(dedupe, /maxJobId: jobId/);
  assert.match(dedupe, /status = 'needs_review'/);
  assert.match(dedupe, /DUPLICATE_TOPIC_PUBLICATION_BLOCKED/);
  assert.match(recovery, /cleanupReadyDuplicateNewArticles/);
  assert.match(recovery, /duplicateCleanup/);
});

test('publisher has a final duplicate gate before any Blogger write', () => {
  const duplicateIndex = publisher.indexOf('DUPLICATE_TOPIC_PUBLICATION_BLOCKED');
  const bloggerWriteIndex = publisher.indexOf("env.HUB_BLOGGER_POST_PATH || '/api/blogger/post'");
  assert.ok(duplicateIndex >= 0);
  assert.ok(bloggerWriteIndex > duplicateIndex);
  assert.match(publisher, /excludeJobId: Number\(candidate\.job_id\)/);
  assert.match(publisher, /maxJobId: Number\(candidate\.job_id\)/);
});

test('legacy API route failures are archived only after newer same-blog same-mode success exists', () => {
  assert.match(legacy, /API_HUB_404/);
  assert.match(legacy, /API_HUB_405/);
  assert.match(legacy, /newer\.id > failed\.id/);
  assert.match(legacy, /newer\.blog_id = failed\.blog_id/);
  assert.match(legacy, /newer\.mode = failed\.mode/);
  assert.match(legacy, /'ready', 'completed', 'publishing_new', 'updating_existing'/);
  assert.match(recovery, /cleanupSupersededLegacyRouteFailures/);
});

test('recovery does not reintroduce long inline image generation', () => {
  assert.doesNotMatch(recovery, /prepareNewArticleImages/);
  assert.match(recovery, /SCHEDULED_IMAGE_COMPLETION/);
});
