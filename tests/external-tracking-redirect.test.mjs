import test from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyAutomatedRequest } from '../worker/lib/external-tracking-redirect.js';

function request(headers = {}) {
  return new Request('https://example.com/go/test', { headers });
}

test('Pinterest and social preview bots are excluded from click metrics', () => {
  assert.equal(isLikelyAutomatedRequest(request({ 'user-agent': 'Pinterestbot/1.0' })), true);
  assert.equal(isLikelyAutomatedRequest(request({ 'user-agent': 'facebookexternalhit/1.1' })), true);
  assert.equal(isLikelyAutomatedRequest(request({ 'user-agent': 'Slackbot-LinkExpanding 1.0' })), true);
});

test('prefetch and preview-purpose requests are excluded', () => {
  assert.equal(isLikelyAutomatedRequest(request({ purpose: 'prefetch' })), true);
  assert.equal(isLikelyAutomatedRequest(request({ 'sec-purpose': 'prefetch;prerender' })), true);
});

test('ordinary browser navigation remains countable', () => {
  assert.equal(isLikelyAutomatedRequest(request({ 'user-agent': 'Mozilla/5.0 Chrome/140.0 Safari/537.36' })), false);
});
