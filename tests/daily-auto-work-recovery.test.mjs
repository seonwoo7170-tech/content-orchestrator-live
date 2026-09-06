import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutomaticWork } from '../worker/lib/daily-auto-work.js';

const blogs = [{ blogId:'b1', name:'Blog 1', url:'https://example.com' }];
const automation = {
  global:{ enabled:true, imagesEnabled:false, operationMode:'validation' },
  blogs:[{ blogId:'b1', resolvedLanguage:'en', effective:{ enabled:true, imagesEnabled:false, operationMode:'validation' } }]
};
const pendingNew = [{ id:1, plan_date:'2026-08-31', blog_id:'b1', blog_name:'Blog 1', kind:'new_article', slot_no:1, status:'pending', recovery_state:'none' }];

test('pre-materialization automatic-work failure is safely registered on the daily slot', async () => {
  let registered = null;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED:'true' },
    blogs,
    automation,
    {
      planDate:'2026-08-31',
      slots:pendingNew,
      callHubFn:async (env,path) => {
        if (path.includes('/posts')) return { posts:[] };
        throw new Error('API_HUB_502:SENSITIVE_PROVIDER_TEXT');
      },
      registerDailySlotFailureFn:async (env,id,code) => {
        registered = {id,code};
        return { slotId:id, code, recoveryState:'retry_wait', retryCount:1, nextRetryAt:'2026-08-31T00:15:00.000Z', holdReason:null };
      }
    }
  );
  assert.deepEqual(registered, {id:1,code:'API_HUB_502'});
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].errorCode, 'API_HUB_502');
  assert.equal(result.items[0].recovery.recoveryState, 'retry_wait');
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_PROVIDER_TEXT/);
});

test('materialized pipeline failure is registered on the failed job with bounded retry state', async () => {
  let getCount = 0;
  let registered = null;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED:'true' },
    blogs,
    automation,
    {
      planDate:'2026-08-31',
      slots:pendingNew,
      callHubFn:async (env,path) => path.includes('/posts') ? {posts:[]} : {topic:'safe topic'},
      findTopicConflictFn:async () => null,
      reservePlannerTopicFn:async () => ({ok:true,candidateId:91,source:'planner'}),
      markTopicCandidateUsedFn:async () => true,
      materializeFn:async () => ({jobId:5,alreadyResolved:false}),
      getStoredJobFn:async () => {
        getCount += 1;
        return getCount === 1
          ? {id:5,mode:'new_article',blog_id:'b1',topic:'safe topic',status:'queued',payload_json:'{"language":"en"}'}
          : {id:5,status:'failed'};
      },
      processStoredJobFn:async () => { throw new Error('API_HUB_503:DO_NOT_EXPOSE_THIS'); },
      registerJobFailureFn:async (env,id,code) => {
        registered = {id,code};
        return { jobId:id, code, recoveryState:'retry_wait', retryCount:1, nextRetryAt:'2026-08-31T00:15:00.000Z', holdReason:null };
      }
    }
  );
  assert.deepEqual(registered, {id:5,code:'API_HUB_503'});
  assert.equal(result.items[0].jobId, 5);
  assert.equal(result.items[0].recovery.recoveryState, 'retry_wait');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE_THIS/);
});
