import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledSearchConsoleCollection } from '../worker/entry.js';

test('scheduled GSC collection fails closed while its execution gate is disabled', async () => {
  const result = await runScheduledSearchConsoleCollection({ GSC_COLLECTION_ENABLED: 'false' }, new Date('2026-08-30T18:15:00Z'), {
    blogs: [{ blogId: '1' }],
    runner: async () => { throw new Error('SHOULD_NOT_RUN'); }
  });
  assert.deepEqual(result, { ok: true, enabled: false, reason: 'GSC_COLLECTION_DISABLED', blogCount: 0 });
});

test('scheduled GSC collection runs only inside its configured five-minute local window', async () => {
  const env = {
    GSC_COLLECTION_ENABLED: 'true',
    GSC_COLLECTION_TIME: '03:15',
    OPERATIONS_TIMEZONE: 'Asia/Seoul'
  };
  let calls = 0;
  const runner = async (_env, blogs, options) => {
    calls += 1;
    assert.equal(blogs.length, 1);
    assert.equal(options.now.toISOString(), '2026-08-30T18:15:00.000Z');
    return { ok: true, blogCount: 1, mappedCount: 1, failedCount: 0 };
  };

  const before = await runScheduledSearchConsoleCollection(env, new Date('2026-08-30T18:10:00Z'), {
    blogs: [{ blogId: '1' }], runner
  });
  assert.equal(before.due, false);
  assert.equal(calls, 0);

  const due = await runScheduledSearchConsoleCollection(env, new Date('2026-08-30T18:15:00Z'), {
    blogs: [{ blogId: '1' }], runner
  });
  assert.equal(due.enabled, true);
  assert.equal(due.due, true);
  assert.equal(due.blogCount, 1);
  assert.equal(calls, 1);

  const after = await runScheduledSearchConsoleCollection(env, new Date('2026-08-30T18:20:00Z'), {
    blogs: [{ blogId: '1' }], runner
  });
  assert.equal(after.due, false);
  assert.equal(calls, 1);
});
