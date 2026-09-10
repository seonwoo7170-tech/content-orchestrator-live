import test from 'node:test';
import assert from 'node:assert/strict';
import { stripWriterOwnedImages } from '../worker/lib/article-image-sanitizer.js';

test('new article sanitizer removes writer-owned image markup but preserves prose', () => {
  const article = {
    title: 'Threshold Repair',
    topic: 'threshold repair',
    language: 'en',
    searchDescription: 'Repair household floor transitions.',
    labels: [],
    sources: [],
    html: '<p>Keep this introduction.</p><figure><img src="https://images.example/a.jpg" alt="workshop"><figcaption>Source: Example</figcaption></figure><h2>Inspect the threshold</h2><p>Keep this section.</p><picture><source srcset="x"><img src="y"></picture><img src="z">'
  };
  const sanitized = stripWriterOwnedImages(article);
  assert.doesNotMatch(sanitized.html, /<img\b/i);
  assert.doesNotMatch(sanitized.html, /<picture\b/i);
  assert.doesNotMatch(sanitized.html, /<figcaption\b/i);
  assert.match(sanitized.html, /Keep this introduction/);
  assert.match(sanitized.html, /Inspect the threshold/);
  assert.match(sanitized.html, /Keep this section/);
});

test('sanitizer leaves image-free articles unchanged by reference', () => {
  const article = { html: '<p>No image here.</p>' };
  assert.equal(stripWriterOwnedImages(article), article);
});
