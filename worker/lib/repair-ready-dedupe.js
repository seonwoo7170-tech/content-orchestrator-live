function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function identityKey(row) {
  const blogId = String(row?.blog_id || '').trim();
  const postId = String(row?.blogger_post_id || '').trim();
  return blogId && postId ? `${blogId}:${postId}` : null;
}

export async function cleanupSupersededReadyRepairs(env) {
  const db = requireDb(env);
  const result = await db.prepare(
    `SELECT j.id, j.blog_id, j.blogger_post_id, j.updated_at,
            p.status AS publication_status
     FROM jobs j
     LEFT JOIN job_publications p ON p.job_id = j.id
     WHERE j.mode = 'repair_existing'
       AND j.status = 'ready'
       AND j.archived_at IS NULL
       AND j.daily_slot_id IS NULL
       AND j.blogger_post_id IS NOT NULL
       AND j.blogger_post_id <> ''
     ORDER BY j.blog_id, j.blogger_post_id, datetime(j.updated_at) DESC, j.id DESC`
  ).all();

  const seen = new Set();
  let archived = 0;
  let canceledScheduledUpdates = 0;
  const keptJobIds = [];
  const supersededJobIds = [];

  for (const row of result.results || []) {
    const key = identityKey(row);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      keptJobIds.push(Number(row.id));
      continue;
    }

    const publicationStatus = String(row.publication_status || '');
    if (publicationStatus && publicationStatus !== 'scheduled_update') continue;

    const statements = [];
    if (publicationStatus === 'scheduled_update') {
      statements.push(db.prepare(
        `DELETE FROM job_publications
         WHERE job_id = ? AND status = 'scheduled_update'`
      ).bind(Number(row.id)));
    }
    statements.push(db.prepare(
      `UPDATE jobs
       SET archived_at = datetime('now'),
           hold_reason = 'SUPERSEDED_REPAIR_JOB',
           updated_at = datetime('now')
       WHERE id = ?
         AND mode = 'repair_existing'
         AND status = 'ready'
         AND archived_at IS NULL`
    ).bind(Number(row.id)));

    const outcomes = await db.batch(statements);
    const archiveResult = outcomes[outcomes.length - 1];
    if (Number(archiveResult?.meta?.changes || 0) === 1) {
      archived += 1;
      supersededJobIds.push(Number(row.id));
      if (publicationStatus === 'scheduled_update') {
        canceledScheduledUpdates += Number(outcomes[0]?.meta?.changes || 0);
      }
    }
  }

  return {
    ok: true,
    archived,
    canceledScheduledUpdates,
    keptJobIds,
    supersededJobIds
  };
}
