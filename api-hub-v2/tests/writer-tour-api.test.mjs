import test from 'node:test';
import assert from 'node:assert/strict';
import { writer } from '../src/lib/ai-routes.js';

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function tourApiOkBody(items) {
  return {
    response: {
      header: { resultCode: '0000', resultMsg: 'OK' },
      body: { items: { item: items }, numOfRows: Array.isArray(items) ? items.length : 1, pageNo: 1 }
    }
  };
}

function tourApiFetch() {
  return async (url) => {
    if (String(url).includes('/detailCommon2')) {
      return jsonResponse(tourApiOkBody({
        contentid: '126508',
        contenttypeid: '12',
        title: 'Gyeongbokgung Palace',
        addr1: 'Seoul',
        firstimage: 'https://img.example/pal.jpg',
        overview: 'A royal palace built in 1395.',
        tel: '+82-2-3700-3900'
      }));
    }
    if (String(url).includes('/detailImage2')) {
      return jsonResponse(tourApiOkBody([{ originimgurl: 'https://img.example/pal-2.jpg' }]));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function baseArticle(overrides = {}) {
  return {
    title: 'Gyeongbokgung Palace: A Complete Visitor Guide',
    html: '<p>Answer.</p>',
    searchDescription: 'Answer.',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'Gyeongbokgung Palace',
    ...overrides
  };
}

test('a tourApiContentId input grounds the writer in real TourAPI facts instead of Tavily search', async () => {
  let userContent = null;
  const binding = aiMock((model, body) => {
    userContent = JSON.parse(body.messages[1].content);
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  const result = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b', TOUR_API_KEY: 'test-key' },
    { blogId: 'smileatlas', language: 'en', tourApiContentId: '126508' },
    binding,
    tourApiFetch()
  );

  assert.equal(userContent.topic, 'Gyeongbokgung Palace');
  assert.equal(userContent.research.provider, 'tour-api');
  assert.match(userContent.research.results[0].content, /A royal palace built in 1395\./);
  assert.equal(result.article.title, baseArticle().title);
});

test('the attraction\'s real photos ride along on the writer response so image planning can use them instead of generating stand-ins', async () => {
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle() }) }));

  const result = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b', TOUR_API_KEY: 'test-key' },
    { blogId: 'smileatlas', language: 'en', tourApiContentId: '126508' },
    binding,
    tourApiFetch()
  );

  assert.deepEqual(result.attractionImages, ['https://img.example/pal.jpg', 'https://img.example/pal-2.jpg']);
});

test('a non-TourAPI-grounded writer call never reports attractionImages at all', async () => {
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle({ topic: 'test topic' }) }) }));

  const result = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    { blogId: '11', topic: 'test topic', language: 'en' },
    binding,
    async () => { throw new Error('must not fetch TourAPI'); }
  );

  assert.equal('attractionImages' in result, false);
});

test('an explicit topic still overrides the attraction title when both are supplied', async () => {
  let userContent = null;
  const binding = aiMock((model, body) => {
    userContent = JSON.parse(body.messages[1].content);
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b', TOUR_API_KEY: 'test-key' },
    { blogId: 'smileatlas', language: 'en', topic: 'Custom Override Topic', tourApiContentId: '126508' },
    binding,
    tourApiFetch()
  );

  assert.equal(userContent.topic, 'Custom Override Topic');
  assert.equal(userContent.research.provider, 'tour-api');
});

test('writer without tourApiContentId behaves exactly as before (no TourAPI fetch attempted)', async () => {
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle({ topic: 'test topic' }) }) }));
  const fetchImpl = async () => { throw new Error('must not fetch TourAPI when tourApiContentId is absent'); };

  const result = await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    { blogId: '11', topic: 'test topic', language: 'en' },
    binding,
    fetchImpl
  );

  assert.equal(result.article.topic, 'test topic');
});

test('a missing/unfound TourAPI attraction fails the writer call instead of silently writing an ungrounded article', async () => {
  const binding = aiMock(() => { throw new Error('must not reach the model'); });
  const notFoundFetch = async () => jsonResponse(tourApiOkBody([]));

  await assert.rejects(
    () => writer(
      { WRITER_MODEL: '@cf/openai/gpt-oss-120b', TOUR_API_KEY: 'test-key' },
      { blogId: 'smileatlas', language: 'en', tourApiContentId: '999999' },
      binding,
      notFoundFetch
    ),
    /TOUR_API_ATTRACTION_NOT_FOUND/
  );
});
