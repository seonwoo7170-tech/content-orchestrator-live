import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  destinationWithUtm,
  externalTrackingCode,
  htmlToPlainText,
  trackedUrl,
  transformArticleForPinterest
} from '../worker/lib/external-traffic.js';

const source = fs.readFileSync(new URL('../worker/lib/external-traffic.js', import.meta.url), 'utf8');

test('Pinterest content transformation defaults to three distinct reusable variants and caps at five', () => {
  const article = { title: '원룸 에어컨 냄새 제거 방법', html: '<p>필터를 먼저 확인합니다.</p><p>전원을 끄고 안전하게 청소합니다.</p>' };
  const three = transformArticleForPinterest(article, { language: 'ko' });
  const five = transformArticleForPinterest(article, { language: 'ko', variants: 99 });
  assert.equal(three.length, 3);
  assert.equal(five.length, 5);
  assert.equal(new Set(three.map((item) => item.title)).size, 3);
  assert.ok(three.every((item) => item.title.length <= 100));
  assert.ok(three.every((item) => item.description.length <= 500));
});

test('HTML conversion strips tags and keeps useful copy', () => {
  const text = htmlToPlainText('<h2>Step</h2><p>Turn off power &amp; clean.</p><script>secret()</script>');
  assert.match(text, /Turn off power & clean/);
  assert.doesNotMatch(text, /<p>|secret\(\)/);
});

test('tracking code and tracking URL are deterministic', () => {
  const one = externalTrackingCode(42, 'pinterest', 3);
  const two = externalTrackingCode(42, 'pinterest', 3);
  assert.equal(one, two);
  assert.match(one, /^[A-Za-z0-9]+$/);
  assert.equal(trackedUrl('https://content-orchestrator.smileseon.workers.dev/base?q=1', one), `https://content-orchestrator.smileseon.workers.dev/go/${one}`);
});

test('redirect destination receives stable source, social medium, campaign and job variant UTM', () => {
  const result = new URL(destinationWithUtm('https://example.com/post?keep=yes', { channel: 'pinterest', jobId: 42, variantNo: 3 }));
  assert.equal(result.searchParams.get('keep'), 'yes');
  assert.equal(result.searchParams.get('utm_source'), 'pinterest');
  assert.equal(result.searchParams.get('utm_medium'), 'social');
  assert.equal(result.searchParams.get('utm_campaign'), 'smileseon_external');
  assert.equal(result.searchParams.get('utm_content'), 'job_42_v3');
});

test('external click tracking stores only referrer host and has no IP or user-agent persistence fields', () => {
  assert.match(source, /referrer_host/);
  assert.doesNotMatch(source, /ip_address|client_ip|user_agent|cf-connecting-ip/i);
});
