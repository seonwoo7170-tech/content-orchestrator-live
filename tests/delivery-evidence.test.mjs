import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryEvidence, deliveryEvidenceComplete, validateBloggerReadback, withBloggerReadbackEvidence } from '../worker/lib/delivery-evidence.js';

const result = {
  article: { title: '테스트 글', html: '<p>본문</p>', language: 'ko', topic: '테스트' },
  finalCritic: { status: 'PASS', score: 100, issues: [] }
};
const qa = { version: 'smileseon-deterministic-qa.v1', status: 'PASS', issues: [] };
const publication = { ok: true, blogId: 'blog-1', bloggerPostId: 'post-7', url: 'https://example.blogspot.com/p/a.html', status: 'LIVE' };
const readback = {
  identity: { blogId: 'blog-1', bloggerPostId: 'post-7', permalink: 'https://example.blogspot.com/p/a.html', status: 'LIVE' }
};

test('completion evidence is incomplete until Blogger readback confirms the same post', () => {
  const pending = buildDeliveryEvidence({
    mode: 'new_article', result, deterministicQa: qa, naturalWritingStatus: 'PASS',
    images: { passed: true, attached: 3, expected: 3 }, imagesRequired: true, publication
  });
  assert.equal(pending.status, 'INCOMPLETE');
  assert.equal(deliveryEvidenceComplete(pending), false);
  assert.equal(pending.gates.find((item) => item.id === 'blogger_readback').passed, false);

  const verified = withBloggerReadbackEvidence(pending, { blogId: 'blog-1', bloggerPostId: 'post-7' }, readback);
  assert.equal(verified.status, 'PASS');
  assert.equal(deliveryEvidenceComplete(verified), true);
});

test('Blogger readback rejects a different post id even when a URL exists', () => {
  const check = validateBloggerReadback(
    { blogId: 'blog-1', bloggerPostId: 'post-7' },
    { identity: { blogId: 'blog-1', bloggerPostId: 'post-8', permalink: 'https://example.blogspot.com/p/b.html' } }
  );
  assert.equal(check.passed, false);
});

test('schema gate can be introduced as required without changing the evidence contract', () => {
  const evidence = buildDeliveryEvidence({
    mode: 'new_article', result, deterministicQa: qa, naturalWritingStatus: 'PASS',
    images: { passed: true }, imagesRequired: false, publication, readback,
    schemaRequired: true, schema: { passed: false, reason: 'SCHEMA_NOT_READY' }
  });
  assert.equal(evidence.status, 'INCOMPLETE');
  assert.equal(evidence.gates.find((item) => item.id === 'schema').required, true);
});
