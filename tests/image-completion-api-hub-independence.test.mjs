import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');

test('scheduled image completion does not depend on API Hub connected blog inventory', () => {
  assert.doesNotMatch(source, /loadConnectedBlogs/);
  assert.match(source, /listReadyImageCandidates\(env, options\)/);
  assert.match(source, /readAutomationSettings\(env, blogs\)/);
  assert.match(source, /candidate\.blog_id/);
});
