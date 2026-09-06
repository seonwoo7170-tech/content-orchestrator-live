import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const blogs = fs.readFileSync(new URL('../web/blogs.js', import.meta.url), 'utf8');

test('blog picker binds the selected Blogger id to the hidden form input', () => {
  assert.match(blogs, /function inputForTrigger\(trigger\)/);
  assert.match(blogs, /querySelector\('input\[data-blog-input\]'\)/);
  assert.match(blogs, /activeBlogInput = inputForTrigger\(trigger\)/);
  assert.doesNotMatch(blogs, /activeBlogInput = triggerForInput\(trigger\)/);
  assert.match(blogs, /activeBlogInput\.value = String\(blog\.blogId\)/);
});
