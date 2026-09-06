const LEGACY_ROUTE_CODES = new Set(['API_HUB_404', 'API_HUB_405']);
const LEGACY_ROUTE_FIX_CUTOFF = '2026-09-04T07:40:20.000Z';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

export async function cleanupSupersededLegacyRouteFailures(env) {
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT failed.id,
            failed.mode,
            failed.blog_id,
            failed.last_error_code,
            failed.retry_count,
            failed.recovery_state,
            failed.last_failure_at,
            failed.updated_at,
            EXISTS (
              SELECT 1
                FROM jobs newer
               WHERE newer.id > failed.id
                 AND newer.blog_id = failed.blog_id
                 AND newer.mode = failed.mode
                 AND newer.status IN ('ready', 'completed', 'publishing_new', 'updating_existing')
            ) AS superseded
       FROM jobs failed
      WHERE failed.status = 'failed'
        AND failed.archived_at IS NULL
        AND failed.last_error_code IN ('API_HUB_404', 'API_HUB_405')
        AND datetime(COALESCE(failed.last_failure_at, failed.updated_at)) < datetime(?)
      ORDER BY failed.id
      LIMIT 50`
  ).bind(LEGACY_ROUTE_FIX_CUTOFF).all();

  const candidates = (rows.results || []).filter((row) => LEGACY_ROUTE_CODES.has(String(row.last_error_code || '')));
  if (!candidates.length) return { ok: true, archived: 0, revived: 0, jobIds: [], revivedJobIds: [] };

  const archiveCandidates = candidates.filter((row) => Number(row.superseded || 0) === 1);
  const reviveCandidates = candidates.filter((row) => Number(row.superseded || 0) !== 1 && String(row.recovery_state || 'none') !== 'retry_wait');

  const archivedJobIds = [];
  if (archiveCandidates.length) {
    const results = await db.batch(archiveCandidates.map((row) => db.prepare(
      `UPDATE jobs
          SET archived_at = datetime('now'),
              recovery_state = 'none',
              next_retry_at = NULL,
              hold_reason = 'SUPERSEDED_LEGACY_ROUTE_FAILURE',
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'failed'
          AND archived_at IS NULL
          AND last_error_code IN ('API_HUB_404', 'API_HUB_405')
          AND datetime(COALESCE(last_failure_at, updated_at)) < datetime(?)`
    ).bind(Number(row.id), LEGACY_ROUTE_FIX_CUTOFF)));
    results.forEach((result, index) => {
      if (Number(result?.meta?.changes || 0) === 1) archivedJobIds.push(Number(archiveCandidates[index].id));
    });
  }

  const revivedJobIds = [];
  if (reviveCandidates.length) {
    const results = await db.batch(reviveCandidates.map((row) => db.prepare(
      `UPDATE jobs
          SET retry_count = 0,
              recovery_state = 'retry_wait',
              next_retry_at = datetime('now'),
              hold_reason = NULL,
              error = NULL,
              last_error_code = NULL,
              last_failure_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'failed'
          AND archived_at IS NULL
          AND last_error_code IN ('API_HUB_404', 'API_HUB_405')
          AND recovery_state <> 'retry_wait'
          AND datetime(COALESCE(last_failure_at, updated_at)) < datetime(?)`
    ).bind(Number(row.id), LEGACY_ROUTE_FIX_CUTOFF)));
    results.forEach((result, index) => {
      if (Number(result?.meta?.changes || 0) === 1) revivedJobIds.push(Number(reviveCandidates[index].id));
    });
  }

  return {
    ok: true,
    archived: archivedJobIds.length,
    revived: revivedJobIds.length,
    jobIds: archivedJobIds,
    revivedJobIds
  };
}
