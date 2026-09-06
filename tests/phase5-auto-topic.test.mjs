import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutomaticWork } from '../worker/lib/daily-auto-work.js';

const blogs = [{ blogId: 'b1', name: 'Blog 1', url: 'https://example.com' }];
const automation = {
  global: { enabled: true, imagesEnabled: false, operationMode: 'growth' },
  blogs: [{ blogId: 'b1', resolvedLanguage: 'ko', effective: { enabled: true, imagesEnabled: false, operationMode: 'growth' } }]
};
const slots = [{ id: 10, plan_date: '2026-09-02', blog_id: 'b1', blog_name: 'Blog 1', kind: 'new_article', slot_no: 1, status: 'pending', recovery_state: 'none' }];

test('daily automation consumes a nonduplicate reserved idea before calling the AI topic planner', async () => {
  let materializedInput = null;
  let marked = null;
  let hubCalls = 0;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED: 'true' },
    blogs,
    automation,
    {
      planDate: '2026-09-02',
      slots,
      reserveTopicCandidateFn: async () => ({ id: 77, query: '원룸 에어컨 냄새 제거', source: 'idea' }),
      findTopicConflictFn: async () => null,
      markTopicCandidateUsedFn: async (_env, candidateId, jobId) => { marked = { candidateId, jobId }; return true; },
      materializeFn: async (_env, _slotId, input) => { materializedInput = input; return { jobId: 31, alreadyResolved: false }; },
      getStoredJobFn: async () => ({ id: 31, mode: 'new_article', blog_id: 'b1', topic: materializedInput.topic, status: 'queued', payload_json: JSON.stringify({ language: 'ko' }) }),
      processStoredJobFn: async () => ({ state: 'ready', result: { status: 'READY' } }),
      callHubFn: async () => { hubCalls += 1; throw new Error('TOPIC_PLANNER_SHOULD_NOT_RUN'); }
    }
  );
  assert.equal(hubCalls, 0);
  assert.equal(materializedInput.topic, '원룸 에어컨 냄새 제거');
  assert.equal(materializedInput.topicCandidateId, 77);
  assert.equal(materializedInput.topicSource, 'idea');
  assert.deepEqual(marked, { candidateId: 77, jobId: 31 });
  assert.equal(result.completed, 1);
  assert.equal(result.items[0].topicSource, 'idea');
});

test('strategy metadata failure never blocks the AI topic fallback when a unique topic can be reserved', async () => {
  const paths = [];
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED: 'true' },
    blogs,
    automation,
    {
      planDate: '2026-09-02',
      slots,
      reserveTopicCandidateFn: async () => { throw new Error('STRATEGY_DB_TEMPORARY'); },
      listStrategyAvoidTopicsFn: async () => { throw new Error('STRATEGY_READ_TEMPORARY'); },
      findTopicConflictFn: async () => null,
      reservePlannerTopicFn: async () => ({ ok: true, candidateId: 88, source: 'planner' }),
      markTopicCandidateUsedFn: async () => true,
      callHubFn: async (_env, path) => {
        paths.push(path);
        if (path.includes('/posts')) return { posts: [] };
        if (path.includes('/topic')) return { topic: '기존 안전 플래너 주제' };
        throw new Error(`UNEXPECTED:${path}`);
      },
      materializeFn: async () => ({ jobId: 32, alreadyResolved: false }),
      getStoredJobFn: async () => ({ id: 32, mode: 'new_article', blog_id: 'b1', topic: '기존 안전 플래너 주제', status: 'queued', payload_json: JSON.stringify({ language: 'ko' }) }),
      processStoredJobFn: async () => ({ state: 'ready', result: { status: 'READY' } })
    }
  );
  assert.ok(paths.some((path) => path.includes('/posts')));
  assert.ok(paths.some((path) => path.includes('/topic')));
  assert.equal(result.completed, 1);
  assert.equal(result.items[0].topicSource, 'planner');
});
