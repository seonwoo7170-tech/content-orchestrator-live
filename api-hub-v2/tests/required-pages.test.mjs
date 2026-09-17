import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRequiredPages } from '../src/lib/required-pages.js';

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const ENV = Object.freeze({
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_WRITER_MODEL: 'gemini-3.5-flash-lite',
  TEXT_PRIMARY_PROVIDER: 'gemini'
});

const MODEL_PAYLOAD = {
  about: { html: '<p>이 블로그는 자취생 생활정보를 다룹니다.</p>' },
  contact: { html: '<p>피드백을 보내주세요.</p>' },
  privacyIntro: '이 블로그는 자취 생활 정보를 다루는 개인 블로그입니다.'
};

function workersMustNotRun() {
  return { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } };
}

test('generates a privacy policy (with boilerplate), about, and contact page in Korean', async () => {
  const result = await generateRequiredPages(ENV, {
    blogName: '자취생활 노하우',
    blogUrl: 'https://example.com',
    topic: '자취생을 위한 생활 정보',
    language: 'ko',
    contactEmail: 'owner@example.com'
  }, workersMustNotRun(), async () => geminiResponse(JSON.stringify(MODEL_PAYLOAD)));

  assert.equal(result.pages.length, 3);
  const [privacy, about, contact] = result.pages;

  assert.equal(privacy.type, 'privacy-policy');
  assert.equal(privacy.title, '개인정보처리방침');
  assert.match(privacy.html, /자취 생활 정보를 다루는 개인 블로그/);
  assert.match(privacy.html, /애드센스/);
  assert.match(privacy.html, /adssettings\.google\.com/);
  assert.match(privacy.html, /owner@example\.com/);

  assert.equal(about.title, '소개');
  assert.match(about.html, /자취생 생활정보/);

  assert.equal(contact.title, '문의하기');
  assert.match(contact.html, /피드백/);
});

test('generates the English privacy policy variant with the AdSense/cookie disclosure', async () => {
  const result = await generateRequiredPages(ENV, {
    blogName: 'Renter Life Tips',
    blogUrl: 'https://example.org',
    topic: 'Practical tips for first-time renters',
    language: 'en'
  }, workersMustNotRun(), async () => geminiResponse(JSON.stringify({
    about: { html: '<p>Tips for renters.</p>' },
    contact: { html: '<p>Reach out anytime.</p>' },
    privacyIntro: 'This blog covers practical advice for people renting their first apartment.'
  })));

  const privacy = result.pages.find((page) => page.type === 'privacy-policy');
  const about = result.pages.find((page) => page.type === 'about');
  const contact = result.pages.find((page) => page.type === 'contact');
  assert.equal(privacy.title, 'Privacy Policy');
  assert.match(privacy.html, /Google AdSense/);
  assert.match(privacy.html, /DoubleClick DART cookie/);
  assert.match(privacy.html, /adssettings\.google\.com/);
  assert.doesNotMatch(privacy.html, /mailto:/); // no contactEmail supplied this time
  assert.equal(about.title, 'About');
  assert.equal(contact.title, 'Contact');
});

test('rejects missing required input before calling the model', async () => {
  const mustNotFetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(() => generateRequiredPages(ENV, { blogUrl: 'https://x.com', topic: 't', language: 'ko' }, workersMustNotRun(), mustNotFetch), /BLOG_NAME_REQUIRED/);
  await assert.rejects(() => generateRequiredPages(ENV, { blogName: 'x', topic: 't', language: 'ko' }, workersMustNotRun(), mustNotFetch), /BLOG_URL_REQUIRED/);
  await assert.rejects(() => generateRequiredPages(ENV, { blogName: 'x', blogUrl: 'https://x.com', language: 'ko' }, workersMustNotRun(), mustNotFetch), /TOPIC_REQUIRED/);
  await assert.rejects(() => generateRequiredPages(ENV, { blogName: 'x', blogUrl: 'https://x.com', topic: 't', language: 'fr' }, workersMustNotRun(), mustNotFetch), /REQUIRED_PAGES_LANGUAGE_INVALID/);
});

test('rejects a malformed model response instead of publishing a broken page', async () => {
  // The shared Gemini retry/validation plumbing (ai-provider-router.js) surfaces any validator
  // rejection as GEMINI_JSON_INVALID after exhausting its retries, rather than the specific
  // REQUIRED_PAGES_* message thrown inside validatePagesShape — same behavior writer()/critic() rely on.
  await assert.rejects(
    () => generateRequiredPages(ENV, {
      blogName: 'x', blogUrl: 'https://x.com', topic: 't', language: 'ko'
    }, workersMustNotRun(), async () => geminiResponse(JSON.stringify({ about: {} }))),
    /GEMINI_JSON_INVALID/
  );
});
