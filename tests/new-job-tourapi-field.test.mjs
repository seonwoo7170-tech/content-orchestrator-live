import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('web/index.html', 'utf8');
const app = fs.readFileSync('web/app.js', 'utf8');
const workerIndex = fs.readFileSync('worker/index.js', 'utf8');

function extractForm(source, id) {
  const start = source.indexOf(`<form id="${id}"`);
  const end = source.indexOf('</form>', start);
  return source.slice(start, end);
}

test('the new-article form lets an operator supply a TourAPI contentId to ground the article in real official facts', () => {
  const form = extractForm(html, 'new-job-form');
  assert.match(form, /name="tourApiContentId"/);
  // POST /api/jobs/new already treats topic as optional once tourApiContentId is supplied
  // (the Hub writer derives the topic from the attraction's own title) -- the form must not
  // block that with a client-side "required" that the backend itself doesn't enforce.
  assert.doesNotMatch(form, /name="topic"[^>]*\brequired\b/);
});

test('the new-job submit handler forwards tourApiContentId only when the operator actually filled it in', () => {
  const start = app.indexOf("newJobForm?.addEventListener('submit'");
  const end = app.indexOf('});', start) + 3;
  const handler = app.slice(start, end);
  assert.match(handler, /tourApiContentId = String\(form\.get\('tourApiContentId'\) \|\| ''\)\.trim\(\)/);
  assert.match(handler, /\.\.\.\(tourApiContentId \? \{ tourApiContentId \} : \{\}\)/);
});

test('the backend route this form posts to actually accepts tourApiContentId and makes topic optional for it', () => {
  const start = workerIndex.indexOf("url.pathname === '/api/jobs/new'");
  const end = workerIndex.indexOf("if (request.method === 'POST' && url.pathname === '/api/jobs/repair-existing')");
  const route = workerIndex.slice(start, end);
  assert.match(route, /const tourApiContentId = String\(input\.tourApiContentId \|\| ''\)\.trim\(\)/);
  assert.match(route, /if \(!String\(input\.topic \|\| ''\)\.trim\(\) && !tourApiContentId\) return json\(\{ error: 'TOPIC_REQUIRED' \}/);
});
