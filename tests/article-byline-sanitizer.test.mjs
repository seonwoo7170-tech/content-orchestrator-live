import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripInBodyPublicationDate } from '../worker/lib/article-byline-sanitizer.js';

// The exact markup published on smileinfo.net, from the live feed on 2026-09-23.
const REAL_INLINE = '<figure><img src="x"></figure>\n<div style="margin-bottom:20px;"><strong>Editorial Team</strong><br>Published: September 11, 2026</div>\n<p>Body.</p>';
const REAL_WRAPPED = '<div class="article-container">\n  <div style="margin-bottom:20px;font-size:14px;color:#555;">\n    <strong>Editorial Team</strong><br>\n    Published: September 18, 2026\n  </div>\n\n  <p>Deciding whether your roof needs a targeted repair.</p>\n</div>';

test('an invented publication date is removed from the body', () => {
  const out = stripInBodyPublicationDate({ html: REAL_INLINE }).html;
  assert.doesNotMatch(out, /Published:/);
  assert.doesNotMatch(out, /September 11, 2026/);
});

// The byline is an editorial call, not this module's business -- only the date goes.
test('the byline beside the date is left alone', () => {
  const out = stripInBodyPublicationDate({ html: REAL_INLINE }).html;
  assert.match(out, /<strong>Editorial Team<\/strong>/);
});

// The whole article sits inside <div class="article-container">. A non-greedy div match would
// have started there and swallowed the wrapper instead of the byline block.
test('the article wrapper is never the block that matches', () => {
  const out = stripInBodyPublicationDate({ html: REAL_WRAPPED }).html;
  assert.match(out, /<div class="article-container">/);
  assert.match(out, /<p>Deciding whether your roof needs a targeted repair\.<\/p>/);
  assert.doesNotMatch(out, /Published:/);
});

// One post had "Published: Standard Guide" where the date should be.
test('a non-date value in the date slot is removed too', () => {
  const out = stripInBodyPublicationDate({ html: '<div><strong>Editorial Team</strong><br>Published: Standard Guide</div><p>Body.</p>' }).html;
  assert.doesNotMatch(out, /Standard Guide/);
  assert.match(out, /<p>Body\.<\/p>/);
});

test('a block holding nothing but the date is removed entirely', () => {
  const out = stripInBodyPublicationDate({ html: '<p>Last updated: April 2026</p><p>Real content here.</p>' }).html;
  assert.equal(out, '<p>Real content here.</p>');
});

// The costly failure mode is deleting article text, so prose is what the guard protects.
test('prose that mentions publishing survives untouched', () => {
  const html = '<p>The manufacturer published a revised torque table in 2024, and the older figure is still printed on many boxes, so check the date stamped on the housing before you trust it.</p>';
  assert.equal(stripInBodyPublicationDate({ html }).html, html);
});

test('a citation carrying its own publication year is untouched', () => {
  const html = '<ul><li><a href="https://epa.gov/x">EPA WaterSense</a> Published: 2024</li></ul>';
  assert.equal(stripInBodyPublicationDate({ html }).html, html);
});

test('the Korean forms are covered', () => {
  const out = stripInBodyPublicationDate({ html: '<div><strong>편집팀</strong><br>게시일: 2026년 3월</div><p>본문.</p>' }).html;
  assert.doesNotMatch(out, /게시일/);
  assert.match(out, /<p>본문\.<\/p>/);
});

test('an article with no such metadata is returned as the same object', () => {
  const article = { html: '<p>Plain article.</p><h2>Heading</h2><p>More.</p>' };
  assert.equal(stripInBodyPublicationDate(article), article);
});

test('a missing article is rejected rather than silently passed through', () => {
  assert.throws(() => stripInBodyPublicationDate(null), /ARTICLE_REQUIRED/);
  assert.throws(() => stripInBodyPublicationDate([]), /ARTICLE_REQUIRED/);
});

// Every path that produces an article body has to be covered, or the defect comes back through
// whichever one was missed -- the repair path is how the existing 33 posts would be corrected.
test('all four article paths run the stripper', async () => {
  const source = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ stripInBodyPublicationDate \} from '\.\/article-byline-sanitizer\.js';/);
  assert.equal((source.match(/stripInBodyPublicationDate\(/g) || []).length, 4);
});

test('the writer is also told not to emit one', async () => {
  const source = await readFile(new URL('../api-hub-v2/src/lib/ai-routes.js', import.meta.url), 'utf8');
  assert.match(source, /PUBLICATION METADATA/);
  assert.match(source, /Blogger renders the real publication date from the post record itself/);
});
