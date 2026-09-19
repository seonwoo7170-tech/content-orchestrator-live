function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

// Klook's affiliate program has no live product-search API (confirmed against the affiliate
// dashboard); the operator periodically exports a CSV from its "제품 탐색기" (product explorer)
// tool and it gets imported here. This is a minimal RFC4180-style parser (quoted fields may
// contain commas, e.g. a product name like "경복궁 한복 대여, 메이크업 및 스냅 촬영").
export function parseKlookProductCsv(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((cells) => cells.some((cell) => String(cell || '').trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((cell) => String(cell || '').trim());
  return nonEmpty.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, index) => { record[name] = String(cells[index] ?? '').trim(); });
    return record;
  });
}

export function extractKlookActivityId(affiliateLink) {
  try {
    const url = new URL(String(affiliateLink || ''));
    const kSite = url.searchParams.get('k_site');
    if (!kSite) return null;
    const decoded = decodeURIComponent(kSite);
    const match = decoded.match(/\/activity\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function normalizeKlookProductRow(row = {}) {
  const activityId = extractKlookActivityId(row['Affiliate Link']);
  const productName = String(row['Product Name (Activity name or Hotel name)'] || '').trim();
  const affiliateLink = String(row['Affiliate Link'] || '').trim();
  if (!activityId || !productName || !affiliateLink) return null;

  const sellPrice = Number(row['Sell Price']);
  const commissionRate = Number(row['Commission Rate']);
  return {
    activityId,
    countryName: String(row['Country Name'] || '').trim() || null,
    cityName: String(row['City Name'] || '').trim() || null,
    productName,
    productImage: String(row['Product Image'] || '').trim() || null,
    currency: String(row['Currency'] || '').trim() || null,
    sellPrice: Number.isFinite(sellPrice) ? sellPrice : null,
    commissionRate: Number.isFinite(commissionRate) ? commissionRate : null,
    instantConfirmation: String(row['Instant Confirmation tag'] || '').trim() === '즉시 확정',
    affiliateLink
  };
}

export async function importKlookProducts(env, csvText) {
  const db = requireDb(env);
  const rows = parseKlookProductCsv(csvText);
  const normalized = rows.map(normalizeKlookProductRow).filter(Boolean);
  const skipped = rows.length - normalized.length;

  if (normalized.length > 0) {
    const statements = normalized.map((item) => db.prepare(
      `INSERT INTO klook_products
         (activity_id, country_name, city_name, product_name, product_image, currency,
          sell_price, commission_rate, instant_confirmation, affiliate_link, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(activity_id) DO UPDATE SET
         country_name = excluded.country_name,
         city_name = excluded.city_name,
         product_name = excluded.product_name,
         product_image = excluded.product_image,
         currency = excluded.currency,
         sell_price = excluded.sell_price,
         commission_rate = excluded.commission_rate,
         instant_confirmation = excluded.instant_confirmation,
         affiliate_link = excluded.affiliate_link,
         updated_at = datetime('now')`
    ).bind(
      item.activityId, item.countryName, item.cityName, item.productName, item.productImage,
      item.currency, item.sellPrice, item.commissionRate, item.instantConfirmation ? 1 : 0, item.affiliateLink
    ));
    await db.batch(statements);
  }

  return { imported: normalized.length, skipped, total: rows.length };
}

// TourAPI (EngService2) reports city/region names in English; the imported Klook catalog
// keeps the Korean city names the CSV export uses. This is a plain lookup rather than a
// translation call so matching stays instant and offline; extend it as more cities are
// imported into the catalog.
const EN_TO_KR_CITY = Object.freeze({
  seoul: '서울',
  busan: '부산',
  incheon: '인천',
  daegu: '대구',
  daejeon: '대전',
  gwangju: '광주',
  ulsan: '울산',
  sejong: '세종',
  jeju: '제주',
  gyeongju: '경주',
  suwon: '수원',
  gangneung: '강릉',
  jeonju: '전주',
  yeosu: '여수',
  tongyeong: '통영',
  sokcho: '속초',
  chuncheon: '춘천',
  pohang: '포항',
  andong: '안동',
  suncheon: '순천',
  gapyeong: '가평',
  pyeongchang: '평창',
  geoje: '거제',
  gangwondo: '강원도',
  seogwipo: '서귀포'
});

function normalizedCityKey(cityNameEn) {
  return String(cityNameEn || '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

export function koreanCityNameFor(cityNameEn) {
  return EN_TO_KR_CITY[normalizedCityKey(cityNameEn)] || null;
}

// A smileatlas article without a tourApiContentId (a general topic like "Best neighborhoods
// to stay in Seoul") still usually names a real Korean city right in its own title/topic --
// this is a plain keyword scan against the same city list findKlookProductsForAttraction
// already knows, not a translation call, so it stays instant and offline. The earliest
// city name to appear wins on the assumption an article leads with its actual subject
// before any incidental later mention of another city (e.g. a day-trip aside).
export function inferKlookCityFromText(text) {
  const normalized = String(text || '').toLowerCase();
  let best = null;
  let bestIndex = Infinity;
  for (const cityNameEn of Object.keys(EN_TO_KR_CITY)) {
    const match = new RegExp(`\\b${cityNameEn}\\b`, 'i').exec(normalized);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      best = cityNameEn;
    }
  }
  return best;
}

// See DEFAULT_KLOOK_AFFILIATE_ID below for why a stable, non-sensitive id is a source
// constant here rather than another wrangler var slot; env.SMILEATLAS_BLOG_ID still
// overrides it if the blog is ever recreated under a different id.
const DEFAULT_SMILEATLAS_BLOG_ID = '4712699686222371580';

export function smileatlasBlogId(env) {
  return String(env?.SMILEATLAS_BLOG_ID || DEFAULT_SMILEATLAS_BLOG_ID).trim();
}

// Klook's affiliate dashboard ("기타 툴" → city page link list) publishes a stable table of
// destination-page ids per city. Unlike the product catalog (which needs a fresh manual CSV
// export per city to have anything to recommend), these ids are a fixed, official mapping:
// they give a always-available "browse this city on Klook" link even for a city with zero
// imported products yet, so this is the safety-net tier under findKlookProductsForAttraction.
const KLOOK_CITY_DESTINATION_ID = Object.freeze({
  seoul: '13',
  busan: '46',
  gangwondo: '156',
  jeju: '20544',
  incheon: '158',
  seogwipo: '25723',
  gyeongju: '8928',
  daegu: '545',
  ulsan: '6955',
  yeosu: '703649',
  andong: '8898'
});

// Free Cloudflare Workers cap total env bindings (vars + secrets) at 64; this worker is
// already close to that ceiling (see image-production-config.test.mjs). Klook's affiliate
// id is a stable, non-sensitive account identifier (tied to the approved partner site, not
// a credential), so it is a source constant here rather than another wrangler var slot.
// env.KLOOK_AFFILIATE_ID still overrides it if ever explicitly configured.
const DEFAULT_KLOOK_AFFILIATE_ID = '135747';

export function klookDestinationLink(env, cityNameEn) {
  const destinationId = KLOOK_CITY_DESTINATION_ID[normalizedCityKey(cityNameEn)];
  if (!destinationId) return null;

  const affiliateId = String(env?.KLOOK_AFFILIATE_ID || DEFAULT_KLOOK_AFFILIATE_ID).trim();
  if (!/^\d+$/.test(affiliateId)) return null;

  const url = new URL(`https://www.klook.com/en-US/destination/c${destinationId}/`);
  url.searchParams.set('aid', affiliateId);
  return url.href;
}

// The operator's Klook export can legitimately cover Klook's whole worldwide catalog, not
// just Korea (the CSV carries its own Country Name per row either way). smileatlas is
// Korea-only, so this is a defensive belt-and-suspenders filter in case some other
// country's city ever happens to share a Korean city's romanized/Korean name — city_name
// matching alone should already be Korea-specific in practice.
const KOREA_COUNTRY_NAME = '대한민국';

export async function findKlookProductsForAttraction(env, { cityNameEn, limit = 3 } = {}) {
  const db = requireDb(env);
  const cityNameKo = koreanCityNameFor(cityNameEn);
  if (!cityNameKo) return [];

  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 3));
  const rows = await db.prepare(
    `SELECT activity_id, country_name, city_name, product_name, product_image, currency,
            sell_price, commission_rate, instant_confirmation, affiliate_link
       FROM klook_products
      WHERE city_name = ? AND (country_name = ? OR country_name IS NULL)
      ORDER BY commission_rate DESC, sell_price ASC
      LIMIT ?`
  ).bind(cityNameKo, KOREA_COUNTRY_NAME, safeLimit).all();

  return (rows.results || []).map((row) => ({
    activityId: row.activity_id,
    countryName: row.country_name,
    cityName: row.city_name,
    productName: row.product_name,
    productImage: row.product_image,
    currency: row.currency,
    sellPrice: row.sell_price,
    commissionRate: row.commission_rate,
    instantConfirmation: Boolean(row.instant_confirmation),
    affiliateLink: row.affiliate_link
  }));
}

// Klook's affiliate program only offers manual CSV export, not a live search API, so catalog
// coverage is only ever as good as what the operator has imported for a given city. This
// surfaces exactly which known cities still have zero products, so a coverage gap is a
// visible, actionable backlog item instead of articles silently publishing without an
// affiliate recommendation.
export async function klookCityCoverage(env) {
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT city_name, COUNT(*) as count FROM klook_products
      WHERE country_name = ? OR country_name IS NULL
      GROUP BY city_name`
  ).bind(KOREA_COUNTRY_NAME).all();
  const counts = new Map((rows.results || []).map((row) => [row.city_name, Number(row.count || 0)]));

  return Object.entries(EN_TO_KR_CITY)
    .map(([cityNameEn, cityNameKo]) => ({
      cityNameEn,
      cityNameKo,
      productCount: counts.get(cityNameKo) || 0
    }))
    .sort((a, b) => a.productCount - b.productCount || a.cityNameEn.localeCompare(b.cityNameEn));
}
