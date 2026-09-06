import test from 'node:test';
import assert from 'node:assert/strict';
import { runDueJobRecoveries } from '../worker/lib/job-recovery-runner.js';

const emptySummary = { jobs:{retryWait:0,held:0,needsReview:0,failed:0,ready:0}, slots:{retryWait:0,held:0,pending:0} };
const noLegacy = async () => ({ok:true,archived:0,jobIds:[]});
const noDuplicates = async () => ({ok:true,checked:0,blocked:0,items:[]});

function cleanups() {
  return { cleanupLegacyFn:noLegacy, cleanupDuplicateFn:noDuplicates };
}

function candidate(overrides = {}) {
  return {
    id: 7,
    mode: 'repair_existing',
    blog_id: 'b1',
    blogger_post_id: 'p1',
    target_url: null,
    topic: null,
    status: 'failed',
    payload_json: '{}',
    retry_count: 1,
    recovery_state: 'retry_wait',
    next_retry_at: '2026-08-31T00:00:00.000Z',
    ...overrides
  };
}

test('job recovery scheduler fails closed when its execution gate is disabled', async () => {
  let called = false;
  const result = await runDueJobRecoveries({}, { listDueFn: async () => { called = true; return []; } });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'JOB_RECOVERY_EXECUTION_DISABLED');
  assert.equal(result.attempted, 0);
  assert.equal(called, false);
});

test('due repair job is claimed once and processed through the stored pipeline', async () => {
  const row = candidate();
  const states = [];
  const result = await runDueJobRecoveries(
    { JOB_RECOVERY_EXECUTION_ENABLED:'true' },
    {
      ...cleanups(),
      now: new Date('2026-08-31T00:05:00.000Z'),
      listDueFn: async () => [row],
      requeueFn: async () => ({ attempted:1, requeued:1, jobIds:[7] }),
      processFn: async (env, passed, options) => {
        assert.equal(passed.status, 'queued');
        await options.saveState('critic_review', {});
        return { state:'ready', result:{status:'READY_TO_UPDATE_EXISTING'} };
      },
      persistTransitionFn: async (env,id,state) => states.push([id,state]),
      summaryFn: async () => emptySummary,
      automation: { blogs:[{blogId:'b1',effective:{imagesEnabled:false}}] }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(states, [[7,'critic_review']]);
  assert.equal(result.items[0].jobState, 'ready');
});

test('recovered new article hands images to scheduled completion instead of generating inline', async () => {
  const row = candidate({ mode:'new_article', blogger_post_id:null, topic:'topic' });
  const result = await runDueJobRecoveries(
    { JOB_RECOVERY_EXECUTION_ENABLED:'true' },
    {
      ...cleanups(),
      listDueFn: async () => [row],
      requeueFn: async () => ({ attempted:1, requeued:1, jobIds:[7] }),
      processFn: async () => ({ state:'ready', result:{status:'READY'} }),
      summaryFn: async () => emptySummary,
      automation: { blogs:[{blogId:'b1',effective:{imagesEnabled:true,bodyImageCount:2}}] }
    }
  );
  assert.equal(result.completed, 1);
  assert.deepEqual(result.items[0].images, {
    enabled:true,
    deferred:true,
    reason:'SCHEDULED_IMAGE_COMPLETION'
  });
});

test('cleanup results are surfaced without consuming retry slots', async () => {
  const result = await runDueJobRecoveries(
    { JOB_RECOVERY_EXECUTION_ENABLED:'true' },
    {
      cleanupLegacyFn: async () => ({ok:true,archived:2,jobIds:[11,12]}),
      cleanupDuplicateFn: async () => ({ok:true,checked:3,blocked:1,items:[{jobId:55}]}),
      listDueFn: async () => [],
      summaryFn: async () => emptySummary,
      automation: { blogs:[] }
    }
  );
  assert.equal(result.attempted, 0);
  assert.equal(result.legacyCleanup.archived, 2);
  assert.equal(result.duplicateCleanup.blocked, 1);
});

test('retry failure is registered with only a safe code and bounded recovery state', async () => {
  const row = candidate();
  const raw = 'API_HUB_502:SENSITIVE_PROVIDER_TEXT';
  let registered = null;
  const result = await runDueJobRecoveries(
    { JOB_RECOVERY_EXECUTION_ENABLED:'true' },
    {
      ...cleanups(),
      listDueFn: async () => [row],
      requeueFn: async () => ({ attempted:1, requeued:1, jobIds:[7] }),
      processFn: async () => { throw new Error(raw); },
      getJobFn: async () => ({ id:7, status:'failed' }),
      registerFailureFn: async (env,id,code) => {
        registered = {id,code};
        return { jobId:id, code, recoveryState:'retry_wait', retryCount:2, nextRetryAt:'2026-08-31T01:00:00.000Z', holdReason:null };
      },
      summaryFn: async () => emptySummary,
      automation: { blogs:[{blogId:'b1',effective:{}}] }
    }
  );
  assert.deepEqual(registered, {id:7,code:'API_HUB_502'});
  assert.equal(result.items[0].status, 'retry_wait');
  assert.equal(result.items[0].errorCode, 'API_HUB_502');
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_PROVIDER_TEXT/);
});
