function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeLimit(value, fallback = 5) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 20) return fallback;
  return number;
}

function safeReadyRepairResult(value, blogId, bloggerPostId) {
  try {
    const result = JSON.parse(String(value || ''));
    return result?.status === 'READY_TO_UPDATE_EXISTING'
      && result?.article
      && String(result?.identity?.blogId || '') === String(blogId || '')
      && String(result?.identity?.bloggerPostId || '') === String(bloggerPostId || '');
  } catch {
    return false;
  }
}

function ambiguousPublication(row) {
  const status = String(row?.publication_status || '');
  const error = String(row?.publication_error || '').toUpperCase();
  return ['claimed', 'verification_pending', 'updated', 'published'].includes(status)
    || error.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN')
    || error.includes('STALE_PUBLICATION_CLAIM');
}

function safeRepairPublication(row) {
  const expected = String(row?.blogger_post_id || '').trim();
  const recorded = String(row?.publication_blogger_post_id || '').trim();
  if (!expected) return false;
  if (recorded && recorded !== expected) return false;
  if (ambiguousPublication(row)) return false;
  return !row?.publication_status || ['failed', 'scheduled_update'].includes(String(row.publication_status));
}

export async function releaseSafeRepairHolds(env, options = {}) {
  const db = requireDb(env);
  const limit = safeLimit(options.limit, 5);
  const rows = await db.prepare(
    `SELECT j.id, j.blog_id, j.blogger_post_id, j.result_json, j.status, j.hold_reason, j.last_error_code,
            p.status AS publication_status, p.blogger_post_id AS publication_blogger_post_id,
            p.error AS publication_error
       FROM jobs j
       LEFT JOIN job_publications p ON p.job_id = j.id
      WHERE j.archived_at IS NULL
        AND j.mode = 'repair_existing'
        AND j.status IN ('failed', 'needs_review')
        AND j.recovery_state = 'held'
        AND j.blogger_post_id IS NOT NULL
        AND j.blogger_post_id <> ''
        AND (
          UPPER(COALESCE(j.hold_reason, '')) LIKE '%MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW%'
          OR UPPER(COALESCE(j.last_error_code, '')) LIKE '%MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW%'
          OR UPPER(COALESCE(j.hold_reason, '')) LIKE '%DUPLICATE_TOPIC_PUBLICATION_BLOCKED%'
          OR UPPER(COALESCE(j.last_error_code, '')) LIKE '%DUPLICATE_TOPIC_PUBLICATION_BLOCKED%'
        )
      ORDER BY j.updated_at, j.id
      LIMIT ?`
  ).bind(limit).all();

  const items = [];
  for (const row of rows.results || []) {
    const jobId = Number(row.id);
    if (!safeRepairPublication(row)) {
      items.push({ jobId, action: 'kept_held', reason: 'REPAIR_PUBLICATION_STATE_AMBIGUOUS' });
      continue;
    }

    const statements = [];
    if (String(row.publication_status || '') === 'failed') {
      statements.push(db.prepare(
        `DELETE FROM job_publications
          WHERE job_id = ? AND status = 'failed' AND blogger_post_id = ?`
      ).bind(jobId, String(row.blogger_post_id)));
    }

    const ready = safeReadyRepairResult(row.result_json, row.blog_id, row.blogger_post_id);
    statements.push(ready
      ? db.prepare(
        `UPDATE jobs
            SET status = 'ready', error = NULL, retry_count = 0, recovery_state = 'none',
                next_retry_at = NULL, hold_reason = NULL, last_error_code = NULL,
                last_failure_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND mode = 'repair_existing' AND recovery_state = 'held'`
      ).bind(jobId)
      : db.prepare(
        `UPDATE jobs
            SET status = 'failed', error = 'REPAIR_SAFE_RETRY_RELEASED', recovery_state = 'retry_wait',
                next_retry_at = ?, hold_reason = NULL, last_error_code = 'REPAIR_SAFE_RETRY_RELEASED',
                last_failure_at = ?, updated_at = datetime('now')
          WHERE id = ? AND mode = 'repair_existing' AND recovery_state = 'held'`
      ).bind(new Date().toISOString(), new Date().toISOString(), jobId));

    statements.push(db.prepare(
      `UPDATE daily_plan_slots
          SET recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
              last_error_code = NULL, last_failure_at = NULL, updated_at = datetime('now')
        WHERE job_id = ?`
    ).bind(jobId));

    const results = await db.batch(statements);
    const jobUpdate = results[statements.length - 2];
    if (Number(jobUpdate?.meta?.changes || 0) !== 1) {
      items.push({ jobId, action: 'skipped', reason: 'REPAIR_HOLD_RELEASE_RACE' });
      continue;
    }
    items.push({ jobId, action: ready ? 'released_ready' : 'released_retry', bloggerPostId: String(row.blogger_post_id) });
  }

  return {
    ok: true,
    checked: (rows.results || []).length,
    releasedReady: items.filter((item) => item.action === 'released_ready').length,
    releasedRetry: items.filter((item) => item.action === 'released_retry').length,
    keptHeld: items.filter((item) => item.action === 'kept_held').length,
    items
  };
}
