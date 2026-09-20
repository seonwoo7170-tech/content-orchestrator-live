import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  extractKlookActivityId,
  findKlookProductsForAttraction,
  importKlookProducts,
  inferKlookCityFromText,
  klookCityCoverage,
  klookDestinationLink,
  koreanCityNameFor,
  normalizeKlookProductRow,
  normalizeKoreanCityName,
  parseKlookProductCsv,
  smileatlasBlogId,
  tourApiConnectedBlogIds
} from '../worker/lib/klook-catalog.js';

const SAMPLE_CSV = `Country Name,City Name,Product Name (Activity name or Hotel name),Product Image,Currency,Sell Price,Commission Rate,Instant Confirmation tag,Affiliate Link
대한민국,서울,서울 시티투어 버스 (도심고궁남산 코스),https://res.klook.com/image/upload/activities/f9674uc1u1gisup8a6eq.jpg,USD,19.45,0.050,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F87163-seoul-city-tour-bus-seoul-trip-center-palaces-course-hop-on-hop-off-bus-tour-seoul
대한민국,서울,"경복궁 한복 대여, 메이크업 및 스냅 촬영",https://res.klook.com/image/upload/activities/hxd7upjavcnw3b23xiap.jpg,USD,31.55,0.050,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F17863-hanbok-photoshoot-hanboknam-seoul
대한민국,서울,서울 경복궁 한복 대여,https://res.klook.com/image/upload/activities/m7iromybhzkbitte4cmo.jpg,USD,4.99,0.050,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F111262-hanbok-rental-in-seoul-gyeongbokgung
`;

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../worker/migrations/0032_klook_products.sql', import.meta.url), 'utf8'));
  const env = {
    ORCHESTRATOR_DB: {
      prepare(sql) {
        return { bind(...args) {
          const statement = db.prepare(sql);
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; }
          };
        } };
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }
    }
  };
  return { env, db };
}

test('parseKlookProductCsv splits standard rows and correctly handles a quoted field containing a comma', () => {
  const rows = parseKlookProductCsv(SAMPLE_CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['City Name'], '서울');
  assert.equal(rows[0]['Sell Price'], '19.45');
  assert.equal(rows[1]['Product Name (Activity name or Hotel name)'], '경복궁 한복 대여, 메이크업 및 스냅 촬영');
  assert.equal(rows[1]['Sell Price'], '31.55');
});

test('extractKlookActivityId pulls the numeric activity id out of the URL-encoded k_site redirect target', () => {
  const link = 'https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F87163-seoul-city-tour-bus';
  assert.equal(extractKlookActivityId(link), '87163');
  assert.equal(extractKlookActivityId('not a url'), null);
  assert.equal(extractKlookActivityId('https://affiliate.klook.com/redirect?aid=1'), null);
});

test('normalizeKlookProductRow converts the Korean "즉시 확정" tag to a boolean and parses numeric fields', () => {
  const rows = parseKlookProductCsv(SAMPLE_CSV);
  const normalized = normalizeKlookProductRow(rows[0]);
  assert.equal(normalized.activityId, '87163');
  assert.equal(normalized.cityName, '서울');
  assert.equal(normalized.sellPrice, 19.45);
  assert.equal(normalized.commissionRate, 0.05);
  assert.equal(normalized.instantConfirmation, true);
});

test('a row whose affiliate link has no extractable activity id is dropped instead of imported with a null key', () => {
  assert.equal(normalizeKlookProductRow({
    'Product Name (Activity name or Hotel name)': 'Broken row',
    'Affiliate Link': 'https://affiliate.klook.com/redirect?aid=135747'
  }), null);
});

test('importKlookProducts upserts by activity id, so re-importing an updated price replaces the old row instead of duplicating it', async (t) => {
  const { env, db } = fixture(t);

  const first = await importKlookProducts(env, SAMPLE_CSV);
  assert.equal(first.imported, 3);
  assert.equal(first.skipped, 0);

  const updatedCsv = SAMPLE_CSV.replace('19.45', '25.00');
  const second = await importKlookProducts(env, updatedCsv);
  assert.equal(second.imported, 3);

  const rows = db.prepare('SELECT * FROM klook_products WHERE activity_id = ?').all('87163');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sell_price, 25);
});

test('koreanCityNameFor maps common English city names to the Korean names the CSV import uses', () => {
  assert.equal(koreanCityNameFor('Seoul'), '서울');
  assert.equal(koreanCityNameFor('busan'), '부산');
  assert.equal(koreanCityNameFor('Unknown City'), null);
});

test('findKlookProductsForAttraction returns city-matched products ordered by commission rate, highest first', async (t) => {
  const { env } = fixture(t);
  await importKlookProducts(env, SAMPLE_CSV);

  const results = await findKlookProductsForAttraction(env, { cityNameEn: 'Seoul', limit: 2 });
  assert.equal(results.length, 2);
  for (const item of results) assert.equal(item.cityName, '서울');
  assert.match(results[0].affiliateLink, /^https:\/\/affiliate\.klook\.com\/redirect\?/);
});

test('findKlookProductsForAttraction returns nothing for a city with no English-to-Korean mapping', async (t) => {
  const { env } = fixture(t);
  await importKlookProducts(env, SAMPLE_CSV);
  const results = await findKlookProductsForAttraction(env, { cityNameEn: 'Atlantis' });
  assert.deepEqual(results, []);
});

test('klookCityCoverage reports zero for every known city that has not been imported yet, sorted emptiest first', async (t) => {
  const { env } = fixture(t);
  await importKlookProducts(env, SAMPLE_CSV);

  const coverage = await klookCityCoverage(env);
  const seoul = coverage.find((item) => item.cityNameEn === 'seoul');
  const busan = coverage.find((item) => item.cityNameEn === 'busan');

  assert.equal(seoul.productCount, 3);
  assert.equal(seoul.cityNameKo, '서울');
  assert.equal(busan.productCount, 0);
  assert.equal(coverage[0].productCount, 0);
  assert.ok(coverage.length >= 20);
});

test('klookCityCoverage reports every known city as zero before any import has happened', async (t) => {
  const { env } = fixture(t);
  const coverage = await klookCityCoverage(env);
  assert.ok(coverage.every((item) => item.productCount === 0));
});

test('a non-Korean product is excluded from both matching and coverage even if its city name happens to collide', async (t) => {
  const { env } = fixture(t);
  await importKlookProducts(env, SAMPLE_CSV);
  const foreignCsv = `Country Name,City Name,Product Name (Activity name or Hotel name),Product Image,Currency,Sell Price,Commission Rate,Instant Confirmation tag,Affiliate Link
태국,서울,Fake foreign product sharing the Seoul city name,https://res.klook.com/image/upload/activities/foreign.jpg,USD,99.00,0.999,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F999999-foreign-product
`;
  await importKlookProducts(env, foreignCsv);

  const results = await findKlookProductsForAttraction(env, { cityNameEn: 'Seoul', limit: 10 });
  assert.equal(results.length, 3);
  assert.ok(!results.some((item) => item.activityId === '999999'));

  const coverage = await klookCityCoverage(env);
  const seoul = coverage.find((item) => item.cityNameEn === 'seoul');
  assert.equal(seoul.productCount, 3);
});

test('klookDestinationLink builds a tracked city page link using the default affiliate id, no env config required', () => {
  assert.equal(klookDestinationLink({}, 'Seoul'), 'https://www.klook.com/en-US/destination/c13/?aid=135747');
  assert.equal(klookDestinationLink({}, 'busan'), 'https://www.klook.com/en-US/destination/c46/?aid=135747');
  assert.equal(klookDestinationLink({}, 'Gangwon-do'), 'https://www.klook.com/en-US/destination/c156/?aid=135747');
  assert.equal(klookDestinationLink({}, 'Seogwipo'), 'https://www.klook.com/en-US/destination/c25723/?aid=135747');
});

test('klookDestinationLink honors an explicit env override of the affiliate id', () => {
  assert.equal(klookDestinationLink({ KLOOK_AFFILIATE_ID: '999999' }, 'Seoul'), 'https://www.klook.com/en-US/destination/c13/?aid=999999');
});

test('klookDestinationLink returns null for a city with no known destination id, instead of a broken link', () => {
  assert.equal(klookDestinationLink({}, 'Atlantis'), null);
});

test('klookDestinationLink returns null when an explicit override is not a valid numeric id', () => {
  assert.equal(klookDestinationLink({ KLOOK_AFFILIATE_ID: 'not-a-number' }, 'Seoul'), null);
});

test('this safety-net link is available for a city (Andong) that has no imported products at all', async (t) => {
  const { env } = fixture(t);
  await importKlookProducts(env, SAMPLE_CSV);

  const products = await findKlookProductsForAttraction(env, { cityNameEn: 'Andong' });
  assert.deepEqual(products, []);
  assert.equal(klookDestinationLink(env, 'Andong'), 'https://www.klook.com/en-US/destination/c8898/?aid=135747');
});

test('inferKlookCityFromText finds a known city name in ordinary article text, case-insensitively', () => {
  assert.equal(inferKlookCityFromText('Best neighborhoods to stay in Seoul for first-time visitors'), 'seoul');
  assert.equal(inferKlookCityFromText('A weekend guide to BUSAN beaches'), 'busan');
  assert.equal(inferKlookCityFromText('Everything to know before visiting Jeju Island'), 'jeju');
});

test('inferKlookCityFromText returns null when no known city is named at all', () => {
  assert.equal(inferKlookCityFromText('Key factors to consider when choosing an AI subscription plan'), null);
  assert.equal(inferKlookCityFromText(''), null);
  assert.equal(inferKlookCityFromText(undefined), null);
});

test('inferKlookCityFromText does not match a city name as a substring of an unrelated word', () => {
  // "Seoulmate" should never resolve to Seoul; the match must be a whole word.
  assert.equal(inferKlookCityFromText('Seoulmate: a productivity app review'), null);
});

test('inferKlookCityFromText prefers whichever known city is named first when an article mentions more than one', () => {
  assert.equal(inferKlookCityFromText('A day trip from Seoul to Incheon and back'), 'seoul');
  assert.equal(inferKlookCityFromText('Busan to Gyeongju: a two-city itinerary'), 'busan');
});

test('smileatlasBlogId defaults to the known smileatlas blog id and can be overridden via env', () => {
  assert.equal(smileatlasBlogId({}), '4712699686222371580');
  assert.equal(smileatlasBlogId({ SMILEATLAS_BLOG_ID: '999' }), '999');
});

test('tourApiConnectedBlogIds defaults to just smileatlas but can be widened via env', () => {
  assert.deepEqual([...tourApiConnectedBlogIds({})], ['4712699686222371580']);
  assert.deepEqual(
    [...tourApiConnectedBlogIds({ TOUR_API_CONNECTED_BLOG_IDS: '111, 222 ,333' })],
    ['111', '222', '333']
  );
});

test('normalizeKoreanCityName strips administrative suffixes so different Klook exports of the same place agree', () => {
  assert.equal(normalizeKoreanCityName('제주도'), '제주');
  assert.equal(normalizeKoreanCityName('제주'), '제주');
  assert.equal(normalizeKoreanCityName('경주시'), '경주');
  assert.equal(normalizeKoreanCityName('서귀포시'), '서귀포');
  assert.equal(normalizeKoreanCityName('강원도'), '강원');
  assert.equal(normalizeKoreanCityName('강원'), '강원');
  assert.equal(normalizeKoreanCityName('제주특별자치도'), '제주');
  assert.equal(normalizeKoreanCityName('서울'), '서울');
});

test('normalizeKoreanCityName never strips a whole one- or two-character place name down to nothing', () => {
  // "도" alone is degenerate input, but must never return an empty string that a broad
  // WHERE city_name = '' could accidentally match against.
  assert.equal(normalizeKoreanCityName('도'), '도');
  assert.equal(normalizeKoreanCityName('시'), '시');
});

test('a Klook export that spells the same place with a different administrative suffix than EN_TO_KR_CITY still matches on import and lookup', async (t) => {
  const { env } = fixture(t);
  const csv = `Country Name,City Name,Product Name (Activity name or Hotel name),Product Image,Currency,Sell Price,Commission Rate,Instant Confirmation tag,Affiliate Link
대한민국,제주도,제주 성산일출봉 입장권,https://res.klook.com/image/upload/activities/jeju.jpg,USD,9.99,0.050,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F55555-jeju-sunrise-peak
대한민국,강원,남이섬 입장권 및 왕복 셔틀버스,https://res.klook.com/image/upload/activities/nami.jpg,USD,14.99,0.050,즉시 확정,https://affiliate.klook.com/redirect?aid=135747&_currency=USD&k_site=https%3A%2F%2Fwww.klook.com%2Fko%2Factivity%2F66666-nami-island
`;
  await importKlookProducts(env, csv);

  const jeju = await findKlookProductsForAttraction(env, { cityNameEn: 'jeju' });
  assert.equal(jeju.length, 1);
  assert.equal(jeju[0].productImage, 'https://res.klook.com/image/upload/activities/jeju.jpg');

  const gangwon = await findKlookProductsForAttraction(env, { cityNameEn: 'gangwondo' });
  assert.equal(gangwon.length, 1);
  assert.equal(gangwon[0].productImage, 'https://res.klook.com/image/upload/activities/nami.jpg');

  const coverage = await klookCityCoverage(env);
  assert.equal(coverage.find((row) => row.cityNameEn === 'jeju').productCount, 1);
  assert.equal(coverage.find((row) => row.cityNameEn === 'gangwondo').productCount, 1);
});
