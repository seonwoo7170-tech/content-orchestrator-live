import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupplementalImagePlan, countArticleImages, resolveImagePolicy, validateImagePolicy } from '../worker/lib/image-policy.js';

const baseArticle = (html = '<p>본문입니다.</p><h2>첫 단계</h2><p>설명입니다.</p><h2>두 번째 단계</h2><p>추가 설명입니다.</p>') => ({
  title: '테스트 글',
  topic: '테스트 주제',
  language: 'ko',
  html
});

const settings = { imagesEnabled: true, bodyImageCount: 2 };

test('counts existing article images without depending on generated job rows', () => {
  assert.equal(countArticleImages(baseArticle()), 0);
  assert.equal(countArticleImages(baseArticle('<p>x</p><img src="a"><figure><img src="b"></figure>')), 2);
});

test('repair with no images plans thumbnail plus two body images', () => {
  const plan = buildSupplementalImagePlan('repair_existing', baseArticle(), settings);
  assert.equal(plan.targetTotal, 3);
  assert.equal(plan.generatedCount, 3);
  assert.equal(plan.needsThumbnail, true);
  assert.equal(plan.bodyNeeded, 2);
  assert.deepEqual(plan.images.map((image) => image.role), ['thumbnail', 'body', 'body']);
});

test('repair supplements only the missing number of images', () => {
  const one = buildSupplementalImagePlan('repair_existing', baseArticle('<img src="existing"><p>x</p>'), settings);
  assert.equal(one.existingCount, 1);
  assert.equal(one.generatedCount, 2);
  assert.equal(one.needsThumbnail, false);
  assert.deepEqual(one.images.map((image) => image.role), ['body', 'body']);

  const two = buildSupplementalImagePlan('repair_existing', baseArticle('<img src="a"><p>x</p><img src="b">'), settings);
  assert.equal(two.generatedCount, 1);
  assert.deepEqual(two.images.map((image) => image.role), ['body']);

  const three = buildSupplementalImagePlan('repair_existing', baseArticle('<img src="a"><img src="b"><img src="c">'), settings);
  assert.equal(three.generatedCount, 0);
  assert.deepEqual(three.images, []);
});

test('image policy blocks repair update until target image count is met', () => {
  const incomplete = validateImagePolicy('repair_existing', baseArticle('<img src="a">'), settings);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.currentCount, 1);
  assert.equal(incomplete.missing, 2);

  const complete = validateImagePolicy('repair_existing', baseArticle('<img src="a"><img src="b"><img src="c">'), settings);
  assert.equal(complete.ok, true);
  assert.equal(complete.missing, 0);
});

test('images can still be explicitly disabled per automation settings', () => {
  const policy = resolveImagePolicy('repair_existing', baseArticle(), { imagesEnabled: false, bodyImageCount: 2 });
  assert.equal(policy.enabled, false);
  assert.equal(policy.targetTotal, 0);
  assert.equal(validateImagePolicy('repair_existing', baseArticle(), { imagesEnabled: false }).ok, true);
});
