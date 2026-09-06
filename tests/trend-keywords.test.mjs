import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calculateTrendScore,
  estimateSeoCompetition,
  parseApproxTraffic,
  parseGoogleTrendsRss,
  trendTopicSimilarity
} from '../worker/lib/trend-keywords.js';
import { isTrendRefreshDue } from '../worker/phase6-trends-entry.js';

const wrangler = fs.readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const mcpEntry = fs.readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../web/trend-insights.js', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('Google Trends approximate traffic values are normalized without inventing search volume', () => {
  assert.equal(parseApproxTraffic('20K+'), 20_000);
  assert.equal(parseApproxTraffic('1.5M+'), 1_500_000);
  assert.equal(parseApproxTraffic('500+'), 500);
  assert.equal(parseApproxTraffic('unknown'), 0);
});

test('Google Trends RSS parser reads query, traffic, news evidence and publication time', () => {
  const xml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
    <item><title><![CDATA[Gemini new feature]]></title><ht:approx_traffic>20K+</ht:approx_traffic>
    <pubDate>Thu, 03 Sep 2026 00:00:00 GMT</pubDate><link>https://trends.google.com/trending?geo=US</link>
    <ht:news_item><ht:news_item_title>one</ht:news_item_title></ht:news_item>
    <ht:news_item><ht:news_item_title>two</ht:news_item_title></ht:news_item></item>
  </channel></rss>`;
  const rows = parseGoogleTrendsRss(xml, 'US');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, 'Gemini new feature');
  assert.equal(rows[0].trafficValue, 20_000);
  assert.equal(rows[0].newsCount, 2);
  assert.equal(rows[0].geo, 'US');
  assert.match(rows[0].publishedAt, /^2026-09-03T00:00:00/);
});

test('trend relevance favors blog-related terms over unrelated breaking topics', () => {
  const related = trendTopicSimilarity('Gemini AI image update', 'Gemini AI image generation guide');
  const unrelated = trendTopicSimilarity('Gemini AI image update', 'baseball playoff score');
  assert.ok(related > 0.5);
  assert.equal(unrelated, 0);
});

test('trend score rewards demand and topical relevance', () => {
  const now = new Date('2026-09-03T01:00:00.000Z');
  const strong = calculateTrendScore({ trafficValue: 100_000, newsCount: 3, relevance: 0.8, publishedAt: '2026-09-03T00:30:00.000Z', now });
  const weak = calculateTrendScore({ trafficValue: 1_000, newsCount: 0, relevance: 0.3, publishedAt: '2026-09-02T12:00:00.000Z', now });
  assert.ok(strong > weak);
  assert.ok(strong <= 100);
});

test('SEO competition is explicitly an internal estimate and existing authority reduces difficulty', () => {
  const withoutAuthority = estimateSeoCompetition({ trafficValue: 100_000, newsCount: 4, relevance: 0.5, authorityPosition: 0 });
  const withAuthority = estimateSeoCompetition({ trafficValue: 100_000, newsCount: 4, relevance: 0.5, authorityPosition: 5 });
  assert.equal(withoutAuthority.method, 'smileseon_seo_estimate_v1');
  assert.match(withoutAuthority.label, /^(low|medium|high)$/);
  assert.ok(withAuthority.score < withoutAuthority.score);
});

test('trend refresh runs only at configured KST slots', () => {
  const env = { TREND_REFRESH_TIMES: '08:35,13:35' };
  assert.equal(isTrendRefreshDue(env, new Date('2026-09-02T23:35:00.000Z')), true);
  assert.equal(isTrendRefreshDue(env, new Date('2026-09-03T04:35:00.000Z')), true);
  assert.equal(isTrendRefreshDue(env, new Date('2026-09-03T04:40:00.000Z')), false);
});

test('runtime and UI clearly separate Trends, GSC average position and estimated SEO competition behind MCP wrapper', () => {
  assert.match(wrangler, /"main": "worker\/mcp-entry\.js"/);
  assert.match(mcpEntry, /import app from '\.\/phase6-trends-entry\.js'/);
  assert.match(wrangler, /"TREND_KEYWORDS_ENABLED": "true"/);
  assert.match(ui, /Google Trends/);
  assert.match(ui, /Google Ads 경쟁률이 아닌 Smileseon 내부 추정치/);
  assert.match(ui, /평균/);
  assert.match(ui, /미색인이라고 단정하지 않습니다/);
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(sw, /trend-insights\.js/);
  assert.match(sw, /live-work-progress\.js/);
});