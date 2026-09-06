import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInternalLinksToArticle } from '../worker/lib/internal-link-injector.js';

test('internal link injector adds up to three safe links and is idempotent', () => {
  const article = { title: '자취 청소법', language: 'ko', html: '<article><p>본문입니다.</p></article>' };
  const links = [
    { query: '주방 청소', url: 'https://example.com/kitchen' },
    { query: '욕실 청소', url: 'https://example.com/bath#top' },
    { query: '세탁기 청소', url: 'https://example.com/laundry' },
    { query: '네 번째', url: 'https://example.com/fourth' }
  ];
  const first = applyInternalLinksToArticle(article, links);
  assert.equal(first.appliedCount, 3);
  assert.match(first.article.html, /data-smileseon-internal-links="1"/);
  assert.match(first.article.html, /함께 읽으면 좋은 글/);
  assert.match(first.article.html, /https:\/\/example\.com\/bath/);
  assert.doesNotMatch(first.article.html, /#top/);
  assert.doesNotMatch(first.article.html, /fourth/);

  const second = applyInternalLinksToArticle(first.article, links);
  assert.equal(second.appliedCount, 0);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.article.html, first.article.html);
});

test('internal link injector rejects unsafe schemes and escapes labels', () => {
  const article = { title: 'Guide', language: 'en', html: '<p>Body</p>' };
  const result = applyInternalLinksToArticle(article, [
    { query: '<script>alert(1)</script>', url: 'https://example.com/good?x=1&y=2' },
    { query: 'bad', url: 'javascript:alert(1)' }
  ]);
  assert.equal(result.appliedCount, 1);
  assert.match(result.article.html, /Related guides/);
  assert.match(result.article.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result.article.html, /x=1&amp;y=2/);
  assert.doesNotMatch(result.article.html, /javascript:/);
});
