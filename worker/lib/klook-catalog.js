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
  geoje: '거제'
});

export function koreanCityNameFor(cityNameEn) {
  const key = String(cityNameEn || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return EN_TO_KR_CITY[key] || null;
}

export async function findKlookProductsForAttraction(env, { cityNameEn, limit = 3 } = {}) {
  const db = requireDb(env);
  const cityNameKo = koreanCityNameFor(cityNameEn);
  if (!cityNameKo) return [];

  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 3));
  const rows = await db.prepare(
    `SELECT activity_id, country_name, city_name, product_name, product_image, currency,
            sell_price, commission_rate, instant_confirmation, affiliate_link
       FROM klook_products
      WHERE city_name = ?
      ORDER BY commission_rate DESC, sell_price ASC
      LIMIT ?`
  ).bind(cityNameKo, safeLimit).all();

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
    `SELECT city_name, COUNT(*) as count FROM klook_products GROUP BY city_name`
  ).bind().all();
  const counts = new Map((rows.results || []).map((row) => [row.city_name, Number(row.count || 0)]));

  return Object.entries(EN_TO_KR_CITY)
    .map(([cityNameEn, cityNameKo]) => ({
      cityNameEn,
      cityNameKo,
      productCount: counts.get(cityNameKo) || 0
    }))
    .sort((a, b) => a.productCount - b.productCount || a.cityNameEn.localeCompare(b.cityNameEn));
}
