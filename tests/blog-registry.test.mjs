import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlogList } from '../worker/lib/blog-registry.js';

test('blog registry normalizes common API Hub shapes and preserves locale metadata', () => {
  assert.deepEqual(
    normalizeBlogList({ blogs: [{ id: 123, name: 'Example', url: 'https://example.com', language: 'en-US', postsTotal: 42 }] }),
    [{ blogId: '123', name: 'Example', url: 'https://example.com', language: 'en-us', postsTotal: 42 }]
  );
});

test('blog registry accepts top-level arrays', () => {
  const [blog] = normalizeBlogList([{ blogId: '1', blogName: 'Blog A' }]);
  assert.equal(blog.name, 'Blog A');
  assert.equal(blog.language, null);
});

test('blog registry rejects duplicate IDs', () => {
  assert.throws(() => normalizeBlogList([{ id: '1' }, { id: '1' }]), /BLOG_ID_DUPLICATE/);
});
