import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledAdsenseCollection } from '../worker/phase4-entry.js';

test('scheduled AdSense collection fails closed while independent gate is disabled', async () => {
  const result = await runScheduledAdsenseCollection({ ADSENSE_COLLECTION_ENABLED: 'false' }, new Date('2026-08-30T18:35:00Z'), {
    blogs: [{ blogId: '1' }],
    runner: async () => { throw new Error('SHOULD_NOT_RUN'); }
  });
  assert.deepEqual(result, { ok: true, enabled: false, reason: 'ADSENSE_COLLECTION_DISABLED', blogCount: 0 });
});

test('scheduled AdSense collection runs only in configured Seoul five-minute window', async () => {
  const env = { ADSENSE_COLLECTION_ENABLED: 'true', ADSENSE_COLLECTION_TIME: '03:35', OPERATIONS_TIMEZONE: 'Asia/Seoul' };
  let calls = 0;
  const runner = async (_env, blogs, options) => {
    calls += 1;
    assert.equal(blogs.length, 1);
    assert.equal(options.now.toISOString(), '2026-08-30T18:35:00.000Z');
    return { ok: true, blogCount: 1, failedCount: 0 };
  };
  const before = await runScheduledAdsenseCollection(env, new Date('2026-08-30T18:30:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(before.due, false);
  assert.equal(calls, 0);
  const due = await runScheduledAdsenseCollection(env, new Date('2026-08-30T18:35:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(due.enabled, true);
  assert.equal(due.due, true);
  assert.equal(due.blogCount, 1);
  assert.equal(calls, 1);
  const after = await runScheduledAdsenseCollection(env, new Date('2026-08-30T18:40:00Z'), { blogs: [{ blogId: '1' }], runner });
  assert.equal(after.due, false);
  assert.equal(calls, 1);
});
