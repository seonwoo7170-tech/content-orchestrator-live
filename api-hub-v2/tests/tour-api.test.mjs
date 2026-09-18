import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTourApiResearch,
  getAttractionDetail,
  listAreaBasedAttractions,
  normalizeAttractionSummary,
  tourApiConfigured
} from '../src/lib/tour-api.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function okBody(items) {
  return {
    response: {
      header: { resultCode: '0000', resultMsg: 'OK' },
      body: { items: { item: items }, numOfRows: Array.isArray(items) ? items.length : 1, pageNo: 1 }
    }
  };
}

const ENV = { TOUR_API_KEY: 'test-service-key' };

test('TourAPI configuration is based only on key presence', () => {
  assert.equal(tourApiConfigured({ TOUR_API_KEY: 'x' }), true);
  assert.equal(tourApiConfigured({ TOUR_API_KEY: '' }), false);
});

test('listAreaBasedAttractions calls the EngService2 endpoint with a raw (non-double-encoded) service key', async () => {
  let requestUrl = null;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return jsonResponse(okBody([
      { contentid: '126508', contenttypeid: '12', title: 'Gyeongbokgung Palace', addr1: 'Seoul', areacode: '1', firstimage: 'https://img.example/pal.jpg' }
    ]));
  };

  const results = await listAreaBasedAttractions(ENV, { areaCode: '1', contentTypeId: '12' }, fetchImpl);

  assert.equal(new URL(requestUrl).origin + new URL(requestUrl).pathname, 'https://apis.data.go.kr/B551011/EngService2/areaBasedList2');
  const query = new URL(requestUrl).searchParams;
  assert.equal(query.get('serviceKey'), 'test-service-key');
  assert.equal(query.get('areaCode'), '1');
  assert.equal(query.get('contentTypeId'), '12');
  assert.equal(query.get('_type'), 'json');
  assert.equal(results.length, 1);
  assert.equal(results[0].contentId, '126508');
  assert.equal(results[0].title, 'Gyeongbokgung Palace');
  assert.equal(results[0].firstImage, 'https://img.example/pal.jpg');
});

test('a single-item response (item as an object, not an array) is normalized into a one-element list', () => {
  const summary = normalizeAttractionSummary({ contentid: '1', title: 'Solo Spot', addr1: 'Busan' });
  assert.equal(summary.contentId, '1');
  assert.equal(summary.title, 'Solo Spot');
});

test('an item with no contentid is dropped instead of producing a broken attraction', () => {
  assert.equal(normalizeAttractionSummary({ title: 'No id here' }), null);
});

test('data.go.kr result codes other than 0000 are surfaced as classified TourAPI errors, not silently accepted', async () => {
  const fetchImpl = async () => jsonResponse({
    response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' } }
  });

  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    (error) => {
      assert.equal(error.message, 'TOUR_API_SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
      assert.equal(error.status, 401);
      return true;
    }
  );
});

test('a bare XML/SOAP fault body is treated as a provider failure instead of throwing an unhandled parse error', async () => {
  const fetchImpl = async () => new Response('<OpenAPI_ServiceResponse>...</OpenAPI_ServiceResponse>', { status: 200 });
  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    /TOUR_API_RESPONSE_NOT_JSON/
  );
});

test('a gateway-level fault (JSON cmmMsgHeader envelope, not the normal response.header shape) is classified by its own reason code', async () => {
  const fetchImpl = async () => jsonResponse({
    cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' }
  });

  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    (error) => {
      assert.equal(error.message, 'TOUR_API_SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
      assert.equal(error.status, 401);
      return true;
    }
  );
});

test('a response with neither the normal header shape nor the gateway fault shape reports the actual top-level keys instead of an opaque UNKNOWN', async () => {
  const fetchImpl = async () => jsonResponse({ somethingUnexpected: true });

  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    /TOUR_API_UNEXPECTED_RESPONSE_SHAPE:keys=somethingUnexpected/
  );
});

test('a transient gateway timeout (e.g. 522) is retried and succeeds once the upstream recovers', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return new Response('', { status: 522 });
    return jsonResponse(okBody([{ contentid: '1', title: 'Recovered Spot', addr1: 'Seoul' }]));
  };

  const results = await listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl);
  assert.equal(calls, 3);
  assert.equal(results[0].title, 'Recovered Spot');
});

test('a transient gateway timeout that never recovers still fails with the real status after retrying', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('', { status: 522 }); };

  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    /TOUR_API_HTTP_522/
  );
  assert.equal(calls, 3);
});

test('a non-transient HTTP failure (e.g. 404) is not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('', { status: 404 }); };

  await assert.rejects(
    () => listAreaBasedAttractions(ENV, { areaCode: '1' }, fetchImpl),
    /TOUR_API_HTTP_404/
  );
  assert.equal(calls, 1);
});

test('getAttractionDetail merges detailCommon2 overview with detailImage2 extra photos, deduplicated', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('/detailCommon2')) {
      return jsonResponse(okBody({
        contentid: '126508',
        contenttypeid: '12',
        title: 'Gyeongbokgung Palace',
        addr1: 'Seoul',
        firstimage: 'https://img.example/pal.jpg',
        overview: 'A <b>royal palace</b> built in 1395.&nbsp;Open daily.',
        tel: '+82-2-3700-3900',
        homepage: '<a href="https://www.royalpalace.go.kr" target="_blank">official site</a>'
      }));
    }
    if (String(url).includes('/detailImage2')) {
      return jsonResponse(okBody([
        { originimgurl: 'https://img.example/pal.jpg' },
        { originimgurl: 'https://img.example/pal-2.jpg' }
      ]));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const detail = await getAttractionDetail(ENV, { contentId: '126508' }, fetchImpl);

  assert.equal(calls.length, 2);
  assert.equal(detail.title, 'Gyeongbokgung Palace');
  assert.equal(detail.overview, 'A royal palace built in 1395. Open daily.');
  assert.equal(detail.telephone, '+82-2-3700-3900');
  assert.equal(detail.homepage, 'https://www.royalpalace.go.kr/');
  assert.deepEqual(detail.images, ['https://img.example/pal.jpg', 'https://img.example/pal-2.jpg']);
});

test('getAttractionDetail still returns the common facts when the image lookup fails', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/detailCommon2')) {
      return jsonResponse(okBody({ contentid: '1', title: 'Spot', addr1: 'Seoul', overview: 'Nice place.' }));
    }
    if (String(url).includes('/detailImage2')) {
      throw new Error('network down');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const detail = await getAttractionDetail(ENV, { contentId: '1' }, fetchImpl);
  assert.equal(detail.title, 'Spot');
  assert.deepEqual(detail.images, []);
});

test('a missing contentId is rejected before any fetch happens', async () => {
  await assert.rejects(
    () => getAttractionDetail(ENV, {}, async () => { throw new Error('must not fetch'); }),
    /TOUR_API_CONTENT_ID_REQUIRED/
  );
});

test('buildTourApiResearch shapes attraction facts into the same research-result contract the writer already trusts', () => {
  const research = buildTourApiResearch({
    contentId: '126508',
    title: 'Gyeongbokgung Palace',
    address: 'Seoul',
    overview: 'A royal palace built in 1395.',
    homepage: 'https://www.royalpalace.go.kr',
    telephone: '+82-2-3700-3900',
    modifiedTime: '20260101120000'
  });

  assert.equal(research.used, true);
  assert.equal(research.provider, 'tour-api');
  assert.equal(research.resultCount, 1);
  assert.equal(research.results.length, 1);
  assert.match(research.results[0].content, /Gyeongbokgung Palace/);
  assert.match(research.results[0].content, /A royal palace built in 1395\./);
  assert.match(research.results[0].url, /contentId=126508/);
});
