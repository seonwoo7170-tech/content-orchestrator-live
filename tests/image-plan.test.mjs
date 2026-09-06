import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStoredImages, buildImagePlan, buildThumbnailHook } from '../worker/lib/image-plan.js';

const ARTICLE = {
  title: '스마트폰 저장공간 안전하게 정리하는 순서',
  topic: '스마트폰 저장공간 정리',
  language: 'ko',
  html: '<p>용량부터 확인하세요.</p><h2>큰 파일 먼저 찾기</h2><p>다운로드 폴더를 확인합니다.</p><h2>사진은 백업 후 정리</h2><p>백업 여부를 확인합니다.</p>'
};

const GLYPH_SEEDING_WORDS = /\b(?:article|poster|infographic|document|package|packaging|sign|signage|interface|text|letters|numbers|labels|captions|watermarks)\b/i;

test('image plan creates positive-only physical-scene prompts', () => {
  const plan = buildImagePlan(ARTICLE, { bodyCount: 2 });
  assert.equal(plan.images.length, 3);
  assert.deepEqual(plan.images.map((image) => image.role), ['thumbnail', 'body', 'body']);
  assert.match(plan.images[0].prompt, /Photorealistic real-world photograph/);
  assert.match(plan.images[0].prompt, /스마트폰 저장공간 정리/);
  assert.match(plan.images[0].prompt, /plain unmarked surfaces/);
  assert.match(plan.images[1].prompt, /큰 파일 먼저 찾기/);
  assert.match(plan.images[2].prompt, /사진은 백업 후 정리/);
  assert.ok(plan.images.every((image) => !GLYPH_SEEDING_WORDS.test(image.prompt)));
  assert.ok(plan.images.every((image) => !/["“”]/.test(image.prompt)));
  assert.equal(plan.images[0].hookText, '놓치면 안 되는 것');
  assert.notEqual(plan.images[0].hookText, ARTICLE.title);
  assert.equal(plan.images[1].hookText, null);
});

test('thumbnail hook is short copy and never the full article title', () => {
  const article = {
    title: 'How to Prioritize Home Repairs When Money Is Tight: A Shelter-First Framework',
    topic: 'home repair priorities on a tight budget',
    language: 'en',
    html: '<p>Start with safety.</p>'
  };
  const hook = buildThumbnailHook(article);
  assert.equal(hook, 'Fix the Risky Stuff First');
  assert.notEqual(hook, article.title);
  const plan = buildImagePlan(article, { bodyCount: 0 });
  assert.equal(plan.images[0].hookText, hook);
  assert.match(plan.images[0].altText, /featured image$/);
  assert.equal(plan.images[0].altText.startsWith(hook), false);
});

test('explicit thumbnail hook is accepted but a hook equal to the title is ignored', () => {
  assert.equal(buildThumbnailHook({
    title: 'Low Shower Water Pressure',
    topic: 'low shower water pressure',
    language: 'en',
    thumbnailHook: 'Check This First'
  }), 'Check This First');
  assert.equal(buildThumbnailHook({
    title: 'Low Shower Water Pressure',
    topic: 'low shower water pressure problem',
    language: 'en',
    thumbnailHook: 'Low Shower Water Pressure'
  }), 'Try This First');
});

test('list numbers in titles do not leak into generated scene prompts', () => {
  const plan = buildImagePlan({
    title: 'Low Shower Water Pressure: 5 Things to Check at Home First',
    topic: 'Low Shower Water Pressure: 5 Things to Check at Home First',
    language: 'en',
    html: '<p>Inspect the fixture.</p>'
  }, { bodyCount: 0 });
  assert.doesNotMatch(plan.images[0].prompt, /\b5\b/);
  assert.doesNotMatch(plan.images[0].prompt, GLYPH_SEEDING_WORDS);
});

test('English image alt text stays English', () => {
  const plan = buildImagePlan({
    title: 'Low Shower Water Pressure',
    topic: 'How to check low shower water pressure',
    language: 'en',
    html: '<h2>Check the showerhead</h2><p>Inspect the fixture.</p>'
  }, { bodyCount: 1 });
  assert.equal(plan.images[0].altText, 'Low Shower Water Pressure featured image');
  assert.equal(plan.images[1].altText, 'Check the showerhead explanatory image');
  assert.doesNotMatch(plan.images.map((image) => image.altText).join(' '), /대표|관련|설명/);
});

test('image plan limits body image count to three', () => {
  assert.throws(() => buildImagePlan(ARTICLE, { bodyCount: 4 }), /BODY_IMAGE_COUNT_INVALID/);
});

test('stored images attach thumbnail first and distribute body images through article paragraphs', () => {
  const article = attachStoredImages(ARTICLE, [
    { id: 1, role: 'thumbnail', position: 0, status: 'stored', public_url: 'https://example.com/media/jobs/1/thumbnail-0.jpg', alt_text: '대표 이미지' },
    { id: 2, role: 'body', position: 1, status: 'stored', public_url: 'https://example.com/media/jobs/1/body-1.jpg', alt_text: '첫 번째 설명 이미지' },
    { id: 3, role: 'body', position: 2, status: 'stored', public_url: 'https://example.com/media/jobs/1/body-2.jpg', alt_text: '두 번째 설명 이미지' }
  ]);

  assert.ok(article.html.startsWith('<figure class="post-image post-image--thumbnail"'));
  const firstBody = article.html.indexOf('data-job-image-id="2"');
  const secondBody = article.html.indexOf('data-job-image-id="3"');
  assert.ok(firstBody > article.html.indexOf('다운로드 폴더를 확인합니다.</p>'));
  assert.ok(secondBody > article.html.indexOf('백업 여부를 확인합니다.</p>'));
  assert.ok(firstBody < secondBody);
  assert.doesNotMatch(article.html, /큰 파일 먼저 찾기<\/h2>\n<figure class="post-image post-image--body"/);
  assert.match(article.html, /loading="eager"/);
  assert.match(article.html, /loading="lazy"/);
});

test('attachment is idempotent for already embedded image ids', () => {
  const rows = [
    { id: 1, role: 'thumbnail', position: 0, status: 'stored', public_url: 'https://example.com/media/jobs/1/thumbnail-0.jpg', alt_text: '대표 이미지' }
  ];
  const once = attachStoredImages(ARTICLE, rows);
  const twice = attachStoredImages(once, rows);
  assert.equal((twice.html.match(/data-job-image-id="1"/g) || []).length, 1);
});
