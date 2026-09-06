import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutomaticWork } from '../worker/lib/daily-auto-work.js';

const blogs = [{ blogId: 'b1', name: 'Blog 1', url: 'https://example.com' }];
const automation = {
  global: { enabled: true, imagesEnabled: true, bodyImageCount: 2, operationMode: 'validation' },
  blogs: [{
    blogId: 'b1',
    resolvedLanguage: 'en',
    effective: { enabled: true, imagesEnabled: true, bodyImageCount: 2, operationMode: 'validation' }
  }]
};
const slots = [{
  id: 1,
  plan_date: '2026-09-03',
  blog_id: 'b1',
  blog_name: 'Blog 1',
  kind: 'new_article',
  slot_no: 1,
  status: 'pending',
  recovery_state: 'none'
}];

test('automatic work returns after article is ready and hands images to scheduled completion', async () => {
  let imageGenerationCalled = false;
  const result = await runAutomaticWork(
    { DAILY_WORK_EXECUTION_ENABLED: 'true' },
    blogs,
    automation,
    {
      planDate: '2026-09-03',
      slots,
      reserveTopicCandidateFn: async () => ({ id: 7, query: 'Safe test topic', source: 'idea' }),
      findTopicConflictFn: async () => null,
      markTopicCandidateUsedFn: async () => true,
      materializeFn: async () => ({ jobId: 51, alreadyResolved: false }),
      getStoredJobFn: async () => ({
        id: 51,
        mode: 'new_article',
        blog_id: 'b1',
        topic: 'Safe test topic',
        status: 'queued',
        payload_json: JSON.stringify({ language: 'en' })
      }),
      processStoredJobFn: async () => ({ state: 'ready', result: { status: 'READY' } }),
      generatePlannedImagesFn: async () => {
        imageGenerationCalled = true;
        throw new Error('IMAGE_GENERATION_MUST_NOT_RUN_IN_WORK_TICK');
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(imageGenerationCalled, false);
  assert.deepEqual(result.items[0].images, {
    enabled: true,
    deferred: true,
    reason: 'SCHEDULED_IMAGE_COMPLETION'
  });
});
