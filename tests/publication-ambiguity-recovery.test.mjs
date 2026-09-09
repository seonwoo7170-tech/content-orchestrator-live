import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publicationAmbiguityInternals } from '../worker/lib/publication-ambiguity-recovery.js';

const {
  normalizeTitle,
  normalizeVisibleText,
  contentMatches,
  matchingMetadata,
  dbTime
} = publicationAmbiguityInternals;

test('unknown publication recovery normalizes title and visible article text without trusting markup', () => {
  assert.equal(normalizeTitle('  How  To Fix  '), 'how to fix');
  assert.equal(normalizeVisibleText('<h2>Hello&nbsp;world</h2><p>A &amp; B</p>'), 'Hello world A & B');
  assert.equal(contentMatches(
    '<h1>Safe repair</h1><p>' + 'same body '.repeat(20) + '</p>',
    { article: { html: '<div>Safe repair</div><p>' + 'same body '.repeat(20) + '</p>' } }
  ), true);
  assert.equal(contentMatches(
    '<h1>Safe repair</h1><p>' + 'same body '.repeat(20) + '</p>',
    { article: { html: '<div>Safe repair</div><p>' + 'different body '.repeat(20) + '</p>' } }
  ), false);
});

test('unknown publication recovery only considers exact-title posts near the failed write time', () => {
  const row = {
    topic: 'Exact Title',
    publication_updated_at: '2026-09-09 11:30:16'
  };
  const result = { article: { title: 'Exact Title' } };
  const posts = [
    { bloggerPostId: 'live', title: 'Exact Title', status: 'live', updated: '2026-09-09T11:30:20Z' },
    { bloggerPostId: 'draft', title: 'Exact Title', status: 'draft', updated: '2026-09-09T11:31:00Z' },
    { bloggerPostId: 'wrong', title: 'Different Title', status: 'live', updated: '2026-09-09T11:30:18Z' },
    { bloggerPostId: 'old', title: 'Exact Title', status: 'live', updated: '2026-09-08T00:00:00Z' }
  ];
  assert.equal(dbTime(row.publication_updated_at), Date.parse('2026-09-09T11:30:16Z'));
  assert.deepEqual(matchingMetadata(row, result, posts).map((post) => post.bloggerPostId), ['live', 'draft']);
});

test('publish-only recovery preserves final result and images instead of restarting paid image generation', () => {
  const source = fs.readFileSync(new URL('../worker/lib/publication-ambiguity-recovery.js', import.meta.url), 'utf8');
  assert.match(source, /statuses:\s*\['live', 'scheduled', 'draft'\]/);
  assert.match(source, /SET status = 'ready'/);
  assert.match(source, /preserveResult:\s*true/);
  assert.match(source, /preserveImages:\s*true/);
  assert.doesNotMatch(source, /DELETE FROM job_images/);
});
