import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  extractKlookActivityId,
  findKlookProductsForAttraction,
  importKlookProducts,
  klookCityCoverage,
  koreanCityNameFor,
  normalizeKlookProductRow,
  parseKlookProductCsv
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
