import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { countInternalLinks, ensureInternalLinks, relatedArticlesSection, siteHostOf } from '../worker/lib/internal-links.js';

const CANDIDATES = [
  { title: 'How to Stop a Running Toilet', url: 'https://www.smileinfo.net/2026/08/how-to-stop-running-toilet.html' },
  { title: 'Why Your Circuit Breaker Trips', url: 'https://www.smileinfo.net/2026/09/why-your-circuit-breaker-trips.html' },
  { title: 'What to Expect During a Home Energy Audit', url: 'https://www.smileinfo.net/2026/09/what-to-expect-during-home-energy-audit.html' }
];
const HOST = 'smileinfo.net';

test('internal links are counted by host, ignoring external ones', () => {
  const html = '<p><a href="https://www.smileinfo.net/a.html">one</a> <a href="https://epa.gov/x">epa</a> <a href="https://smileinfo.net/b.html">two</a></p>';
  assert.equal(countInternalLinks(html, HOST), 2);
  assert.equal(siteHostOf('https://www.smileinfo.net/a.html'), HOST);
});

// 32 of 33 published posts look exactly like this.
test('a body with no internal links gets a related section built from real posts', () => {
  const out = ensureInternalLinks({ html: '<p>Body.</p>', language: 'en' }, CANDIDATES, { host: HOST }).html;
  assert.match(out, /<h2 id="related-articles">Related Articles<\/h2>/);
  assert.equal(countInternalLinks(out, HOST), 3);
  assert.match(out, /How to Stop a Running Toilet/);
  // The body it was given is untouched and still first.
  assert.ok(out.startsWith('<p>Body.</p>'));
});

// The section is a floor, not a fixture: an article the writer already linked properly keeps its
// own contextual links and gains nothing bolted on the end.
test('an article that already links internally is left alone', () => {
  const html = '<p>See <a href="https://www.smileinfo.net/a.html">this</a> and <a href="https://www.smileinfo.net/b.html">that</a>.</p>';
  const article = { html, language: 'en' };
  assert.equal(ensureInternalLinks(article, CANDIDATES, { host: HOST }), article);
});

test('a candidate the body already links to is not repeated in the section', () => {
  const html = `<p>See <a href="${CANDIDATES[0].url}">it</a>.</p>`;
  const out = ensureInternalLinks({ html, language: 'en' }, CANDIDATES, { host: HOST }).html;
  assert.equal((out.match(/how-to-stop-running-toilet/g) || []).length, 1);
});

test('with nothing published yet the article is returned unchanged', () => {
  const article = { html: '<p>Body.</p>' };
  assert.equal(ensureInternalLinks(article, [], { host: HOST }), article);
  assert.equal(relatedArticlesSection([], 'en'), '');
});

test('titles and urls are escaped, so a quote in a title cannot break the markup', () => {
  const section = relatedArticlesSection([{ title: 'A "quoted" & <odd> title', url: 'https://x.test/a?b=1&c=2' }], 'en');
  assert.match(section, /&quot;quoted&quot; &amp; &lt;odd&gt;/);
  assert.match(section, /a\?b=1&amp;c=2/);
  assert.doesNotMatch(section, /<odd>/);
});

test('a Korean blog gets a Korean heading', () => {
  assert.match(relatedArticlesSection(CANDIDATES, 'ko'), /함께 읽으면 좋은 글/);
});

// Master v4.5 restricts the Blogger body to a fixed tag list; the section must stay inside it.
test('the section uses only tags the spec permits', () => {
  const section = relatedArticlesSection(CANDIDATES, 'en');
  const tags = [...section.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
  for (const tag of new Set(tags)) {
    assert.ok(['section', 'h2', 'ul', 'li', 'a'].includes(tag), `unexpected tag: ${tag}`);
  }
});

test('a missing article is rejected rather than silently passed through', () => {
  assert.throws(() => ensureInternalLinks(null, CANDIDATES), /ARTICLE_REQUIRED/);
});

test('the writer is handed the candidates, and told the comment placeholder no longer applies', async () => {
  const routes = await readFile(new URL('../api-hub-v2/src/lib/ai-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /INTERNAL LINKS — internalLinkCandidates, when supplied/);
  assert.match(routes, /these are the URLs, so use them and do not leave the comment in their place/);
  assert.match(routes, /internalLinkCandidates: input\.internalLinkCandidates\.slice\(0, 12\)/);
});

test('both writer paths resolve candidates, and a read failure never fails the article', async () => {
  const pipeline = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  // The new-article path and the existing-post rewrite path, by the argument each passes.
  assert.match(pipeline, /resolveInternalLinkCandidates\(env, request\?\.blogId\)/);
  assert.match(pipeline, /resolveInternalLinkCandidates\(env, identity\.blogId\)/);
  const helper = pipeline.slice(pipeline.indexOf('async function resolveInternalLinkCandidates'), pipeline.indexOf('async function emitStage'));
  assert.match(helper, /catch \{\s*return \[\];\s*\}/);
});

test('publication applies the floor, excluding the post being published', async () => {
  const publisher = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(publisher, /excludeJobId: jobId/);
  assert.match(publisher, /article: await withInternalLinks\(/);
  const helper = publisher.slice(publisher.indexOf('async function withInternalLinks'), publisher.indexOf('async function resolveScheduledAt'));
  assert.match(helper, /catch \{\s*return article;\s*\}/);
});

// Repair is the path the already-published posts are corrected through, and every one of them
// was written before the writer had any internal URL to link to. Leaving the floor off this path
// would mean the 33 existing posts could never gain one.
test('the repair path applies the floor as well', async () => {
  const updater = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');
  assert.match(updater, /article: await withInternalLinks\(/);
  assert.match(updater, /excludeJobId: jobId/);
  const helper = updater.slice(updater.indexOf('async function withInternalLinks'));
  assert.match(helper, /catch \{\s*return article;\s*\}/);
});
