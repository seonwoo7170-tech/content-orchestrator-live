import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWriterResearch, shouldUseTavilyResearch, tavilyConfigured, tavilySearch } from '../src/lib/tavily-search.js';

test('Tavily configuration is based only on secret presence', () => {
  assert.equal(tavilyConfigured({ TAVILY_API_KEY: 'secret' }), true);
  assert.equal(tavilyConfigured({ TAVILY_API_KEY: '' }), false);
});

test('auto research triggers for freshness-sensitive and substantive evergreen topics', () => {
  assert.equal(shouldUseTavilyResearch('Windows 11 2026 update guide'), true);
  assert.equal(shouldUseTavilyResearch('최신 AI 모델 비교'), true);
  assert.equal(shouldUseTavilyResearch('How to clean a stainless steel sink'), true);
  assert.equal(shouldUseTavilyResearch('Threshold repair and restoration'), true);
  assert.equal(shouldUseTavilyResearch('A short personal reflection'), false);
  assert.equal(shouldUseTavilyResearch('anything', 'always'), true);
  assert.equal(shouldUseTavilyResearch('latest news', 'off'), false);
});

test('Tavily search uses Bearer auth, Basic depth and returns sanitized results', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      results: [
        { title: 'Official update', url: 'https://example.com/update', content: 'Current details', score: 0.9, published_date: '2026-08-30' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await tavilySearch({ TAVILY_API_KEY: 'tvly-test' }, { query: 'test query', maxResults: 3 }, fetchImpl);
  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.equal(request.init.headers.authorization, 'Bearer tvly-test');
  const body = JSON.parse(request.init.body);
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.include_answer, false);
  assert.equal(body.include_raw_content, false);
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].url, 'https://example.com/update');
});

test('Tavily errors never expose provider response bodies', async () => {
  const fetchImpl = async () => new Response('provider secret detail', { status: 429 });
  await assert.rejects(
    () => tavilySearch({ TAVILY_API_KEY: 'secret' }, { query: 'query' }, fetchImpl),
    error => error.message === 'TAVILY_RATE_LIMITED' && !String(error.message).includes('provider secret detail')
  );
});

test('auto writer research degrades safely when Tavily is missing', async () => {
  const research = await collectWriterResearch({}, { topic: '2026 current policy update', language: 'en' });
  assert.equal(research.requested, true);
  assert.equal(research.used, false);
  assert.equal(research.unavailableReason, 'not_configured');
});

test('always writer research fails closed when Tavily is missing', async () => {
  await assert.rejects(
    () => collectWriterResearch({}, { topic: 'current policy update', language: 'en', researchMode: 'always' }),
    /TAVILY_REQUIRED_BUT_NOT_CONFIGURED/
  );
});

test('fresh writer research uses a month window and returns only grounded source records', async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      results: [
        { title: 'Source A', url: 'https://example.com/a', content: 'Fact A', score: 0.8 },
        { title: 'Source B', url: 'https://example.com/b', content: 'Fact B', score: 0.7 }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const research = await collectWriterResearch(
    { TAVILY_API_KEY: 'secret' },
    { topic: 'latest software release', language: 'en' },
    fetchImpl
  );
  assert.equal(body.time_range, 'month');
  assert.equal(research.used, true);
  assert.equal(research.resultCount, 2);
});

test('evergreen writer research does not force a freshness window', async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      results: [
        { title: 'Repair guidance', url: 'https://example.com/repair', content: 'Stable repair guidance', score: 0.9 }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const research = await collectWriterResearch(
    { TAVILY_API_KEY: 'secret' },
    { topic: 'Threshold repair and restoration', language: 'en' },
    fetchImpl
  );
  assert.equal(body.time_range, undefined);
  assert.match(body.query, /official guidance practical decision criteria/i);
  assert.equal(research.used, true);
});
