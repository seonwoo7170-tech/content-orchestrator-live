import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rescue = fs.readFileSync('worker/lib/job-auto-rescue.js', 'utf8');
const recoveryRunner = fs.readFileSync('worker/lib/job-recovery-runner.js', 'utf8');
const live = fs.readFileSync('web/work-live-progress.js', 'utf8');
const home = fs.readFileSync('web/home-live-status.js', 'utf8');
const sw = fs.readFileSync('web/sw.js', 'utf8');

test('unfinished review and stale text-pipeline jobs are automatically rescued with a bounded cap', () => {
  assert.match(rescue, /status = 'needs_review'/);
  for (const status of ['queued', 'writing', 'critic_review', 'repairing', 'final_critic']) {
    assert.match(rescue, new RegExp(status));
  }
  assert.match(rescue, /STALE_PIPELINE_EXECUTION/);
  assert.match(rescue, /retry_count = retry_count \+ 1/);
  assert.match(rescue, /MAX_JOB_RETRIES/);
  assert.match(rescue, /RETRY_LIMIT_REACHED/);
  assert.match(recoveryRunner, /primeAutomaticJobRescue/);
  assert.match(recoveryRunner, /autoRescue/);
});

test('automatic rescue never blindly repeats duplicate or ambiguous Blogger writes', () => {
  assert.match(rescue, /DUPLICATE_TOPIC_PUBLICATION_BLOCKED/);
  assert.match(rescue, /BLOGGER_WRITE_OUTCOME_UNKNOWN/);
  assert.match(rescue, /STALE_PUBLICATION_CLAIM/);
  assert.match(rescue, /MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW/);
  assert.match(rescue, /hasUnsafePublication/);
  assert.match(rescue, /recovery_state = 'held'/);
});

test('work cards show concrete live stage, image progress, retries and timestamps while a job runs', () => {
  assert.match(live, /Writer가 글을 작성 중/);
  assert.match(live, /Critic이 글을 검수 중/);
  assert.match(live, /지적된 부분을 Repair 중/);
  assert.match(live, /최종 Critic 검수 중/);
  assert.match(live, /Blogger 신규 글 발행 중/);
  assert.match(live, /<strong>다음:<\/strong>/);
  assert.match(live, /<strong>재시도<\/strong>/);
  assert.match(live, /<strong>이미지<\/strong>/);
  assert.match(live, /<strong>마지막 갱신<\/strong>/);
  assert.match(live, /<strong>다음 재시도<\/strong>/);
  assert.match(live, /처리 흐름/);
});

test('live progress preserves the known job identity across transient empty reads', () => {
  assert.match(live, /function stableLiveRow/);
  assert.match(live, /card\._liveJobRow/);
  assert.match(live, /row\.id = Number\(row\.id\) \|\| Number\(jobId\)/);
  assert.match(live, /if \(!row\) return null/);
});

test('manual run and rewrite are intercepted before vague legacy running labels and polled live', () => {
  assert.match(live, /\['run', 'retry-readable'\]/);
  assert.match(live, /stopImmediatePropagation/);
  assert.match(live, /startFocusedTracking/);
  assert.match(live, /1200/);
  assert.match(live, /이미 실행 중입니다\. 현재 단계를 아래에 표시합니다/);
  assert.match(live, /진행 상태 표시 중/);
});

test('live progress loads before work-card click handlers and is available offline in the current PWA cache', () => {
  assert.match(home, /^import '\.\/work-live-progress\.js';/);
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(sw, /work-live-progress\.js/);
  assert.match(sw, /live-work-progress\.js/);
});