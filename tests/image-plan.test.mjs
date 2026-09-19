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
  assert.match(plan.images[0].prompt, /uncluttered composition/);
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

// Confirmed via production job #161: a Korean particle glued directly onto a number
// ("2026년") still satisfies \b\d+\b's word boundary, so the digit-stripping meant for
// English listicle titles ("5 Ways to...") silently dropped the year and fed the image
// model a broken "년 파워서플라이..." topic with no numeric context at all.
test('a number followed directly by a Korean particle is not stripped from the topic', () => {
  const plan = buildImagePlan({
    title: '2026년 파워서플라이 권장 용량 계산 방법과 고장 증상 자가진단 가이드',
    topic: '2026년 파워서플라이 권장 용량 계산 방법과 고장 증상 자가진단 가이드',
    language: 'ko',
    html: '<p>intro</p>'
  }, { bodyCount: 0 });
  assert.match(plan.images[0].prompt, /2026년 파워서플라이/);
});

// A section's <h2> alone can be too short/terse to ground an image accurately (confirmed
// on job #161's "ATX 규격과 12V 2X6 커넥터의 이해" heading, which alone gave the image model
// nothing concrete and it hallucinated an unrelated scene). The body paragraph that
// actually explains the section should be pulled into the prompt too.
test('body image prompts include the explaining paragraph, not just the bare heading', () => {
  const plan = buildImagePlan({
    title: 'ATX 파워서플라이 커넥터 가이드',
    topic: 'ATX 파워서플라이 커넥터 가이드',
    language: 'ko',
    html: '<h2>ATX 규격과 12V 2X6 커넥터의 이해</h2><p>ATX3.0 규격부터 도입된 12V-2x6 커넥터는 최대 600W까지 전력을 공급할 수 있습니다. 핀이 휘지 않도록 주의해야 합니다.</p>'
  }, { bodyCount: 1 });
  assert.match(plan.images[1].prompt, /This section explains:/);
  // A decimal-style token ("ATX3.0", "12V-2x6") must not be mistaken for a sentence
  // boundary and truncate the detail after just "atx3".
  assert.match(plan.images[1].prompt, /ATX3\.0 규격부터 도입된 12V-2x6 커넥터는 최대 600W까지 전력을 공급할 수 있습니다/);
  assert.doesNotMatch(plan.images[1].prompt, /explains: ATX3\.\s/);
  assert.doesNotMatch(plan.images[1].prompt, /\.\.\s/);
});

test('a section with no following paragraph text falls back gracefully with no dangling detail clause', () => {
  const plan = buildImagePlan({
    title: 'Quick fixture check',
    topic: 'quick fixture check',
    language: 'en',
    html: '<h2>Inspect the fixture</h2>'
  }, { bodyCount: 1 });
  assert.doesNotMatch(plan.images[1].prompt, /This section explains:\s*\./);
});

test('image plan allows up to six body images and rejects beyond that', () => {
  assert.doesNotThrow(() => buildImagePlan(ARTICLE, { bodyCount: 4 }));
  assert.doesNotThrow(() => buildImagePlan(ARTICLE, { bodyCount: 6 }));
  assert.throws(() => buildImagePlan(ARTICLE, { bodyCount: 7 }), /BODY_IMAGE_COUNT_INVALID/);
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

test('image prompts no longer nudge every scene toward showing a person\'s hands', () => {
  // topicDominance() used to say "When a person is useful, show hands or forearms
  // actively performing the relevant task" on every single image (thumbnail + all body
  // images), which made the model default to hands-doing-something as the safe framing
  // for nearly any real-world scene regardless of whether the topic called for it.
  const plan = buildImagePlan(ARTICLE, { bodyCount: 2 });
  assert.ok(plan.images.every((image) => !/hands? or forearms/i.test(image.prompt)));
  assert.ok(plan.images.every((image) => !/when a person is useful/i.test(image.prompt)));
  assert.match(plan.images[0].prompt, /not a posed portrait/i);
});

test('attachment is idempotent for already embedded image ids', () => {
  const rows = [
    { id: 1, role: 'thumbnail', position: 0, status: 'stored', public_url: 'https://example.com/media/jobs/1/thumbnail-0.jpg', alt_text: '대표 이미지' }
  ];
  const once = attachStoredImages(ARTICLE, rows);
  const twice = attachStoredImages(once, rows);
  assert.equal((twice.html.match(/data-job-image-id="1"/g) || []).length, 1);
});
