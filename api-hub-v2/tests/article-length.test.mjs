import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lengthContract, lengthVerdict, measureArticleLength, visibleText } from '../src/lib/article-length.js';

test('visible text excludes markup, scripts and entities', () => {
  const html = '<h2>Title</h2><p>Body &amp; more</p><script>var a=1;</script><style>p{}</style>';
  assert.equal(visibleText(html), 'Title Body & more');
});

test('length is counted in characters, and the familiar word number is reported beside it', () => {
  const en = measureArticleLength({ html: '<p>one two three four five</p>' });
  assert.equal(en.chars, 'one two three four five'.length);
  assert.equal(en.latinWords, 5);
  const ko = measureArticleLength({ html: '<p>본문 내용이 길어야 합니다</p>' });
  assert.ok(ko.hangulChars > 0);
  assert.ok(ko.approxWords > 0);
});

// The band is the whole point: a number the model cannot re-estimate its way out of.
test('each language gets its own floor, and deep-dive scales it', () => {
  const en = lengthContract('en');
  const ko = lengthContract('ko');
  assert.ok(en.floorChars > ko.floorChars, 'English needs more characters than Korean for the same content');
  assert.ok(en.targetChars > en.floorChars);
  assert.ok(lengthContract('en', 'deep-dive').floorChars > en.floorChars);
  assert.equal(lengthContract('ko', 'standard-explainer').floorChars, ko.floorChars);
});

test('an unknown language does not silently get a zero floor', () => {
  assert.ok(lengthContract('fr').floorChars > 0);
  assert.ok(lengthContract(undefined).floorChars > 0);
});

// smileinfo.net's published median: 5,586 characters of visible text against an editorial band
// asking for 1,500-2,500 words. Nothing counted, so nothing caught it.
test('the median article actually published is recognised as below the floor', () => {
  const body = `<p>${'x'.repeat(5586)}</p>`;
  const verdict = lengthVerdict({ html: body }, 'en');
  assert.equal(verdict.chars, 5586);
  assert.equal(verdict.belowFloor, true);
  assert.ok(verdict.shortfallChars > 0);
});

test('an article at the target is not flagged', () => {
  const contract = lengthContract('en');
  const verdict = lengthVerdict({ html: `<p>${'x'.repeat(contract.targetChars)}</p>` }, 'en');
  assert.equal(verdict.belowFloor, false);
  assert.equal(verdict.shortfallChars, 0);
});

test('the writer is given the contract and the critic the measurement, neither estimating', async () => {
  const source = await readFile(new URL('../src/lib/ai-routes.js', import.meta.url), 'utf8');
  assert.match(source, /lengthContract: lengthContract\(language, input\?\.seoBrief\?\.planning\?\.recommendedDepth\)/);
  assert.match(source, /const measuredLength = lengthVerdict\(/);
  assert.match(source, /article: stripEvidence\(article\),\s*measuredLength,/);
  // The old instructions asked both of them to estimate; that is the defect.
  assert.doesNotMatch(source, /estimate your draft's visible word count/i);
  assert.doesNotMatch(source, /Estimate the Article's total word count/i);
  assert.match(source, /Do not estimate the length yourself and do not dispute these numbers/);
});

test('repair is given the same numbers it has to close', async () => {
  const source = await readFile(new URL('../src/lib/ai-routes.js', import.meta.url), 'utf8');
  const repairBlock = source.slice(source.indexOf('export async function repair'));
  assert.match(repairBlock, /measuredLength: lengthVerdict\(repairArticle/);
});

test('the critic result carries the measurement so the job record keeps it', async () => {
  const source = await readFile(new URL('../src/lib/ai-routes.js', import.meta.url), 'utf8');
  const criticReturn = source.slice(source.indexOf("auditMode: 'master-v4.5-role-critic") - 400, source.indexOf("auditMode: 'master-v4.5-role-critic"));
  assert.match(criticReturn, /measuredLength,/);
});
