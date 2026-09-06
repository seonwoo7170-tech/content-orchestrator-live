import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicationDisplayStatus,
  reconcileDueScheduledPublications
} from '../worker/lib/publication-status.js';

test('scheduled publication remains reservation wait before its Blogger publish time', () => {
  assert.equal(
    publicationDisplayStatus('scheduled', '2026-09-06T10:00:00+09:00', new Date('2026-09-06T00:30:00Z')),
    'scheduled'
  );
});

test('due scheduled publication becomes confirmation pending until Blogger reports LIVE', () => {
  assert.equal(
    publicationDisplayStatus('scheduled', '2026-09-06T09:00:00+09:00', new Date('2026-09-06T00:01:00Z')),
    'verification_pending'
  );
  assert.equal(
    publicationDisplayStatus('published', '2026-09-06T09:00:00+09:00', new Date('2026-09-06T00:01:00Z')),
    'published'
  );
});

test('Blogger LIVE readback promotes the stored scheduled publication to published', async () => {
  const marked = [];
  const result = await reconcileDueScheduledPublications({}, '2026-09-06', {
    now: new Date('2026-09-06T01:00:00Z'),
    listDueFn: async () => [{ job_id: 93, blog_id: 'blog-1', blogger_post_id: 'post-1' }],
    callHubFn: async (_env, path, input) => {
      assert.equal(path, '/api/blogger/post/get');
      assert.deepEqual(input, { blogId: 'blog-1', bloggerPostId: 'post-1' });
      return { identity: { status: 'LIVE', permalink: 'https://example.com/live.html' } };
    },
    markCheckedFn: async (_env, row, readback, isLive) => {
      marked.push({ row, readback, isLive });
      return true;
    }
  });

  assert.deepEqual(result, { checked: 1, published: 1, pending: 0 });
  assert.equal(marked.length, 1);
  assert.equal(marked[0].isLive, true);
});

test('non-LIVE Blogger readback stays pending and never claims publication completion', async () => {
  let markedLive = null;
  const result = await reconcileDueScheduledPublications({}, '2026-09-06', {
    now: new Date('2026-09-06T01:00:00Z'),
    listDueFn: async () => [{ job_id: 94, blog_id: 'blog-2', blogger_post_id: 'post-2' }],
    callHubFn: async () => ({ identity: { status: 'SCHEDULED' } }),
    markCheckedFn: async (_env, _row, _readback, isLive) => {
      markedLive = isLive;
      return false;
    }
  });

  assert.deepEqual(result, { checked: 1, published: 0, pending: 1 });
  assert.equal(markedLive, false);
});
