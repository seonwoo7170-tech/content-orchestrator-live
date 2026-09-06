function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

const ORDER_SQL = Object.freeze({
  earnings: 'estimated_earnings DESC, page_views_rpm DESC, page_url ASC',
  rpm: 'page_views_rpm DESC, page_views DESC, estimated_earnings DESC, page_url ASC',
  views: 'page_views DESC, estimated_earnings DESC, page_views_rpm DESC, page_url ASC'
});

export function normalizeAdsensePageOrder(value) {
  const order = String(value || 'earnings').trim().toLowerCase();
  return Object.hasOwn(ORDER_SQL, order) ? order : 'earnings';
}

export async function listRankedAdsensePages(env, snapshotDate, blogId, options = {}) {
  const db = requireDb(env);
  const order = normalizeAdsensePageOrder(options.order);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 10));
  const minPageViews = order === 'rpm' ? Math.max(0, Math.min(1000000, Number(options.minPageViews) || 1)) : 0;
  const result = await db.prepare(
    `SELECT snapshot_date, blog_id, page_url, page_path, status, error_code,
      page_views, impressions, clicks, estimated_earnings, page_views_rpm, currency_code, collected_at
     FROM adsense_page_snapshots
     WHERE snapshot_date = ? AND blog_id = ? AND page_views >= ?
     ORDER BY ${ORDER_SQL[order]}
     LIMIT ?`
  ).bind(String(snapshotDate), String(blogId), minPageViews, limit).all();
  return { order, minPageViews, rows: result?.results || [] };
}
