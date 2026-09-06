import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDailySlotAssignment } from '../worker/lib/daily-slot-materializer.js';

test('new article slot requires a topic and normalizes language', () => {
  assert.deepEqual(
    normalizeDailySlotAssignment(
      { id: 1, blog_id: 'blog-1', kind: 'new_article', status: 'pending' },
      { topic: '  Windows blue screen causes  ', language: 'EN' }
    ),
    {
      mode: 'new_article',
      blogId: 'blog-1',
      topic: 'Windows blue screen causes',
      language: 'en',
      dailySlotId: 1
    }
  );
  assert.throws(
    () => normalizeDailySlotAssignment({ id: 1, blog_id: 'blog-1', kind: 'new_article', status: 'pending' }, {}),
    /TOPIC_REQUIRED/
  );
});

test('repair slot requires an existing Blogger Post ID', () => {
  const job = normalizeDailySlotAssignment(
    { id: 2, blog_id: 'blog-2', kind: 'repair_existing', status: 'pending' },
    { bloggerPostId: '987', targetUrl: 'https://example.com/post' }
  );
  assert.equal(job.bloggerPostId, '987');
  assert.equal(job.dailySlotId, 2);
  assert.throws(
    () => normalizeDailySlotAssignment({ id: 2, blog_id: 'blog-2', kind: 'repair_existing', status: 'pending' }, {}),
    /BLOGGER_POST_ID_REQUIRED/
  );
});

test('skipped daily slot cannot materialize', () => {
  assert.throws(
    () => normalizeDailySlotAssignment({ id: 3, blog_id: 'blog-3', kind: 'new_article', status: 'skipped' }, { topic: 'x' }),
    /DAILY_SLOT_SKIPPED/
  );
});
