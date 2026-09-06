import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledAnalyticsCollection } from '../worker/entry.js';

test('scheduled GA4 collection fails closed while its independent gate is disabled', async () => {
  const result = await runScheduledAnalyticsCollection({ GA4_COLLECTION_ENABLED: 'false' }, new Date('2026-08-30T18:25:00Z'), {
    blogs: [{ blogId: '1' }],
    runner: async () => { throw new Error('SHOULD_NOT_RUN'); }
  });
  assert.deepEqual(result, { ok: true, enabled: false, reason: 'GA4_COLLECTION_DISABLED', blogCount: 0 });
});

test('scheduled GA4 collection runs only in the configured Seoul five-minute window', async () => {
  const env = { GA4_COLLECTION_ENABLED: 'true', GA4_COLLECTION_TIME: '03:25', OPERATIONS_TIMEZONE: 'Asia/Seoul' };
  let calls = 0;
  const runner = async (_env, blogs, options) => {
    calls += 1;
    assert.equal(blogs.length, 1);
    assert.equal(options.now.toISOString(), '2026-08-30T18:25:00.000Z');
    return { ok: true, blogCount: 1, mappedCount: 1, failedCount: 0 };
  };
  const before = await runScheduledAnalyticsCollection(env, new Date('2026-08-30T18:20:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(before.due, false);
  assert.equal(calls, 0);
  const due = await runScheduledAnalyticsCollection(env, new Date('2026-08-30T18:25:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(due.enabled, true);
  assert.equal(due.due, true);
  assert.equal(due.blogCount, 1);
  assert.equal(calls, 1);
  const after = await runScheduledAnalyticsCollection(env, new Date('2026-08-30T18:30:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(after.due, false);
  assert.equal(calls, 1);
});
