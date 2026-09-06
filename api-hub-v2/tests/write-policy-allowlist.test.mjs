import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBloggerWriteAllowed } from '../src/lib/write-policy.js';

const ENV = {
  BLOGGER_WRITES_ENABLED: 'true',
  BLOGGER_WRITE_MODE: 'managed_allowlist',
  BLOGGER_WRITE_ALLOWED_BLOG_IDS: 'a,b,c,d'
};

test('managed allowlist permits create/scheduled only for configured blogs', () => {
  assert.equal(assertBloggerWriteAllowed(ENV, { blogId: 'a', operation: 'create', publishMode: 'scheduled' }), true);
  assert.equal(assertBloggerWriteAllowed(ENV, { blogId: 'b', operation: 'create', publishMode: 'draft' }), true);
  assert.throws(
    () => assertBloggerWriteAllowed(ENV, { blogId: 'x', operation: 'create', publishMode: 'scheduled' }),
    /BLOGGER_WRITE_TARGET_NOT_ALLOWED/
  );
});

test('managed allowlist permits existing-post updates only with an explicit Blogger Post ID', () => {
  assert.equal(assertBloggerWriteAllowed(ENV, { blogId: 'c', operation: 'update', bloggerPostId: 'post-1' }), true);
  assert.throws(
    () => assertBloggerWriteAllowed(ENV, { blogId: 'c', operation: 'update' }),
    /BLOGGER_WRITE_EXISTING_POST_ID_REQUIRED/
  );
});

test('managed allowlist fails closed on unsupported operations and disabled global gate', () => {
  assert.throws(
    () => assertBloggerWriteAllowed(ENV, { blogId: 'd', operation: 'delete' }),
    /BLOGGER_WRITE_OPERATION_NOT_ALLOWED/
  );
  assert.throws(
    () => assertBloggerWriteAllowed({ ...ENV, BLOGGER_WRITES_ENABLED: 'false' }, { blogId: 'a', operation: 'create' }),
    /BLOGGER_WRITES_DISABLED/
  );
});
