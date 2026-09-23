import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPublicationDate, formatPublicationDate } from '../worker/lib/article-byline-sanitizer.js';

// Master v4.5 section 62 requires this block. The writer emits it correctly and then has to
// invent [DATE], because publication is scheduled long after drafting. The block stays; the
// value is filled at publication from the date actually being used.
const REAL = '<div class="article-container">\n  <div style="margin-bottom:20px;">\n    <strong>Editorial Team</strong><br>\n    Published: September 11, 2026\n  </div>\n  <p>Body prose that must survive untouched.</p>\n  <p>Last updated: March 2026</p>\n</div>';

test('the guessed publication date is replaced with the real one', () => {
  const out = applyPublicationDate({ html: REAL, language: 'en' }, { publishedAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' }).html;
  assert.match(out, /Published: September 21, 2026/);
  assert.doesNotMatch(out, /September 11, 2026/);
  assert.match(out, /Last updated: September 21, 2026/);
  assert.doesNotMatch(out, /March 2026/);
});

// The whole point of the correction: the spec requires the block, so it must not be removed.
test('the byline block the spec requires is kept', () => {
  const out = applyPublicationDate({ html: REAL, language: 'en' }, { publishedAt: '2026-09-21T00:00:00Z' }).html;
  assert.match(out, /<div class="article-container">/);
  assert.match(out, /<strong>Editorial Team<\/strong>/);
  assert.match(out, /<p>Body prose that must survive untouched\.<\/p>/);
});

// One post had "Published: Standard Guide" where the date should be.
test('a non-date value in the date slot is overwritten, not left', () => {
  const out = applyPublicationDate(
    { html: '<div><strong>Editorial Team</strong><br>Published: Standard Guide</div>', language: 'en' },
    { publishedAt: '2026-09-05T00:00:00Z' }
  ).html;
  assert.match(out, /Published: September 5, 2026/);
  assert.doesNotMatch(out, /Standard Guide/);
});

// Updating an existing post: this side does not hold its original publication date, so the line
// is removed rather than restamped with today -- restamping a date without changing the content
// is exactly what Google names as a search-first signal.
test('an update fills only what it honestly knows', () => {
  const out = applyPublicationDate({ html: REAL, language: 'en' }, { updatedAt: '2026-09-23T09:00:00Z' }).html;
  assert.doesNotMatch(out, /Published:/);
  assert.match(out, /Last updated: September 23, 2026/);
  assert.match(out, /<strong>Editorial Team<\/strong>/);
});

test('a Korean article keeps its own label', () => {
  const out = applyPublicationDate(
    { html: '<div><strong>편집팀</strong><br>게시일: 2026년 3월</div>', language: 'ko' },
    { publishedAt: '2026-09-23T00:00:00Z' }
  ).html;
  assert.match(out, /게시일: 2026년 9월 23일/);
  assert.doesNotMatch(out, /Published/);
});

// The costly failure mode is damaging article text, so prose and citations are what this protects.
test('prose that mentions publishing survives untouched', () => {
  const html = '<p>The manufacturer published a revised torque table in 2024, so check the date stamped on the housing before you trust it.</p>';
  assert.equal(applyPublicationDate({ html }, { publishedAt: '2026-09-23T00:00:00Z' }).html, html);
});

test('a citation carrying its own publication year is untouched', () => {
  const html = '<ul><li><a href="https://epa.gov/x">EPA WaterSense</a> Published: 2024</li></ul>';
  assert.equal(applyPublicationDate({ html }, { publishedAt: '2026-09-23T00:00:00Z' }).html, html);
});

test('an unusable date is not written into the article', () => {
  const out = applyPublicationDate({ html: REAL, language: 'en' }, { publishedAt: 'not-a-date' }).html;
  assert.doesNotMatch(out, /Published:/);
  assert.equal(formatPublicationDate('not-a-date'), null);
});

test('a missing article is rejected rather than silently passed through', () => {
  assert.throws(() => applyPublicationDate(null, {}), /ARTICLE_REQUIRED/);
  assert.throws(() => applyPublicationDate([], {}), /ARTICLE_REQUIRED/);
});

// The date only exists at publication, so that is the only place this can run. Running it at
// drafting time -- where it was first wired -- would strip the block before publication ever
// saw it, breaking the spec.
test('it runs at publication, not at drafting', async () => {
  const pipeline = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pipeline, /PublicationDate/);
  const publisher = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(publisher, /article: applyPublicationDate\(result\.article, \{\s*publishedAt: scheduledAt,/);
  const updater = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');
  assert.match(updater, /applyPublicationDate\(result\.article, \{ updatedAt: new Date\(\)\.toISOString\(\) \}\)/);
});

test('the writer is told to leave the date as the placeholder the server fills', async () => {
  const source = await readFile(new URL('../api-hub-v2/src/lib/ai-routes.js', import.meta.url), 'utf8');
  assert.match(source, /leave every date in them as the literal token \[DATE\]/);
  assert.match(source, /the server substitutes the real date into those blocks before publishing/);
  // It must no longer tell the writer to drop the block Master v4.5 requires.
  assert.doesNotMatch(source, /never write a publication date, an update date, a review date or a byline/);
});
