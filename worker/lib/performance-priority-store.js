import { buildPerformancePriorityInputs, rankPerformancePriorities } from './performance-priority.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

async function allRows(db, sql) {
  const result = await db.prepare(sql).all();
  return Array.isArray(result?.results) ? result.results : [];
}

export async function loadPerformancePriorityRows(env) {
  const db = requireDb(env);
  const [gsc, ga4, adsense] = await Promise.all([
    allRows(db, `SELECT snapshot_date, blog_id, window_days, status, error_code,
      clicks, impressions, ctr, position, collected_at
      FROM gsc_snapshots
      WHERE window_days IN (7, 28)
      ORDER BY snapshot_date DESC, blog_id ASC, window_days ASC`),
    allRows(db, `SELECT snapshot_date, blog_id, window_days, status, error_code,
      active_users, total_users, sessions, engaged_sessions, engagement_rate,
      average_session_duration, screen_page_views, collected_at
      FROM ga4_snapshots
      WHERE window_days IN (7, 28)
      ORDER BY snapshot_date DESC, blog_id ASC, window_days ASC`),
    allRows(db, `SELECT snapshot_date, blog_id, window_days, status, error_code,
      page_views, impressions, clicks, estimated_earnings, page_views_rpm,
      currency_code, collected_at
      FROM adsense_snapshots
      WHERE window_days IN (7, 28)
      ORDER BY snapshot_date DESC, blog_id ASC, window_days ASC`)
  ]);
  return { gsc, ga4, adsense };
}

export async function listPerformancePriorities(env, blogs) {
  const evidence = await loadPerformancePriorityRows(env);
  const inputs = buildPerformancePriorityInputs({ blogs, ...evidence });
  return {
    rows: rankPerformancePriorities(inputs),
    evidenceCounts: {
      gsc: evidence.gsc.length,
      ga4: evidence.ga4.length,
      adsense: evidence.adsense.length
    }
  };
}
