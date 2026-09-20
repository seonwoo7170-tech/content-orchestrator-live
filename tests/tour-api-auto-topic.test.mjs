import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutomaticWork } from '../worker/lib/daily-auto-work.js';

const SMILEATLAS_BLOG_ID = '4712699686222371580';
const blogs = [{ blogId: SMILEATLAS_BLOG_ID, name: 'Smile Atlas', url: 'https://example.com' }];
const automation = {
  global: { enabled: true, imagesEnabled: false, operationMode: 'growth' },
  blogs: [{ blogId: SMILEATLAS_BLOG_ID, resolvedLanguage: 'ko', effective: { enabled: true, imagesEnabled: false, operationMode: 'growth' } }]
};
const slots = [{
  id: 10, plan_date: '2026-09-20', blog_id: SMILEATLAS_BLOG_ID, blog_name: 'Smile Atlas',
  kind: 'new_article', slot_no: 1, status: 'pending', recovery_state: 'none'
}];

test('a TourAPI-connected blog with no reserved idea gets a real attraction topic instead of asking the AI planner', async () => {
  let materializedInput = null;
  let aiTopicPlannerCalled = false;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED: 'true' },
    blogs,
    automation,
    {
      planDate: '2026-09-20',
      slots,
      reserveTopicCandidateFn: async () => null,
      listStrategyAvoidTopicsFn: async () => [],
      findTopicConflictFn: async () => null,
      reservePlannerTopicFn: async () => ({ ok: true, candidateId: 200 }),
      markTopicCandidateUsedFn: async () => true,
      selectTourApiAttractionTopicFn: async () => ({ topic: '경복궁 여행 전 꼭 알아야 할 것들', tourApiContentId: '126508' }),
      callHubFn: async (_env, path) => {
        if (path.includes('/posts')) return { posts: [] };
        if (path.includes('/topic')) { aiTopicPlannerCalled = true; return { topic: 'AI가 지어낸 일반적인 여행 팁' }; }
        throw new Error(`UNEXPECTED:${path}`);
      },
      materializeFn: async (_env, _slotId, input) => { materializedInput = input; return { jobId: 41, alreadyResolved: false }; },
      getStoredJobFn: async () => ({ id: 41, mode: 'new_article', blog_id: SMILEATLAS_BLOG_ID, topic: materializedInput.topic, status: 'queued', payload_json: JSON.stringify({ language: 'ko' }) }),
      processStoredJobFn: async () => ({ state: 'ready', result: { status: 'READY' } })
    }
  );
  assert.equal(aiTopicPlannerCalled, false);
  assert.equal(materializedInput.topic, '경복궁 여행 전 꼭 알아야 할 것들');
  assert.equal(materializedInput.tourApiContentId, '126508');
  assert.equal(materializedInput.topicSource, 'tour-api');
  assert.equal(result.completed, 1);
  assert.equal(result.items[0].topicSource, 'tour-api');
});

test('falls back to the AI topic planner when no unused TourAPI attraction is available', async () => {
  let materializedInput = null;
  let aiTopicPlannerCalled = false;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED: 'true' },
    blogs,
    automation,
    {
      planDate: '2026-09-20',
      slots,
      reserveTopicCandidateFn: async () => null,
      listStrategyAvoidTopicsFn: async () => [],
      findTopicConflictFn: async () => null,
      reservePlannerTopicFn: async () => ({ ok: true, candidateId: 201 }),
      markTopicCandidateUsedFn: async () => true,
      selectTourApiAttractionTopicFn: async () => null,
      callHubFn: async (_env, path) => {
        if (path.includes('/posts')) return { posts: [] };
        if (path.includes('/topic')) { aiTopicPlannerCalled = true; return { topic: '기존 안전 플래너 주제' }; }
        throw new Error(`UNEXPECTED:${path}`);
      },
      materializeFn: async (_env, _slotId, input) => { materializedInput = input; return { jobId: 42, alreadyResolved: false }; },
      getStoredJobFn: async () => ({ id: 42, mode: 'new_article', blog_id: SMILEATLAS_BLOG_ID, topic: materializedInput.topic, status: 'queued', payload_json: JSON.stringify({ language: 'ko' }) }),
      processStoredJobFn: async () => ({ state: 'ready', result: { status: 'READY' } })
    }
  );
  assert.equal(aiTopicPlannerCalled, true);
  assert.equal(materializedInput.topic, '기존 안전 플래너 주제');
  assert.equal(materializedInput.tourApiContentId, undefined);
  assert.equal(materializedInput.topicSource, 'planner');
  assert.equal(result.items[0].topicSource, 'planner');
});
