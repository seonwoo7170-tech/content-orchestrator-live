import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExistingIdentity, updateExistingPost } from '../worker/lib/publisher.js';

test('existing repair must keep original Blogger Post ID', () => {
  assert.equal(assertExistingIdentity(
    { blogId: 'blog-1', bloggerPostId: 'post-1' },
    { blogId: 'blog-1', bloggerPostId: 'post-1' }
  ), true);
  assert.throws(() => assertExistingIdentity(
    { blogId: 'blog-1', bloggerPostId: 'post-1' },
    { blogId: 'blog-1', bloggerPostId: 'post-2' }
  ), /BLOGGER_POST_ID_CHANGED/);
});

test('Blogger update is disabled by default', async () => {
  await assert.rejects(() => updateExistingPost(
    { BLOGGER_WRITES_ENABLED: 'false' },
    { blogId: 'blog-1', bloggerPostId: 'post-1' },
    { blogId: 'blog-1', bloggerPostId: 'post-1' }
  ), /BLOGGER_WRITES_DISABLED/);
});
