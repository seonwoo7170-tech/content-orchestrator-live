function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

export async function persistDailySlots(env, slots) {
  const db = requireDb(env);
  if (!Array.isArray(slots)) throw new Error('DAILY_SLOTS_REQUIRED');
  if (!slots.length) return { requested: 0, inserted: 0, reactivated: 0 };

  // Only slots that were skipped by workload reconciliation may be revived. Clean skips such
  // as "no repair candidate" and any materialized/resolved slot stay untouched.
  const reactivateStatements = slots.map((slot) => db.prepare(
    `UPDATE daily_plan_slots
     SET status = 'pending', job_id = NULL, priority_score = ?, retry_count = 0,
         recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
         last_error_code = NULL, last_failure_at = NULL, updated_at = datetime('now')
     WHERE plan_date = ? AND blog_id = ? AND kind = ? AND slot_no = ?
       AND status = 'skipped' AND job_id IS NULL AND last_error_code = 'WORKLOAD_RECONCILED'`
  ).bind(
    Number(slot.priorityScore || 0),
    slot.planDate,
    slot.blogId,
    slot.kind,
    slot.slotNo
  ));

  const reactivatedResults = await db.batch(reactivateStatements);
  const reactivated = (reactivatedResults || []).reduce(
    (sum, result) => sum + Number(result?.meta?.changes ?? 0),
    0
  );

  const statements = slots.map((slot) => db.prepare(
    `INSERT OR IGNORE INTO daily_plan_slots
      (plan_date, blog_id, blog_name, kind, slot_no, status, priority_score, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'), datetime('now'))`
  ).bind(slot.planDate, slot.blogId, slot.blogName || null, slot.kind, slot.slotNo, Number(slot.priorityScore || 0)));

  const results = await db.batch(statements);
  const inserted = (results || []).reduce((sum, result) => sum + Number(result?.meta?.changes ?? 0), 0);
  return { requested: slots.length, inserted, reactivated };
}

export async function listDailySlots(env, planDate) {
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT id, plan_date, blog_id, blog_name, kind, slot_no, status, job_id, priority_score,
            retry_count, recovery_state, next_retry_at, hold_reason, last_error_code, last_failure_at,
            created_at, updated_at
     FROM daily_plan_slots
     WHERE plan_date = ?
     ORDER BY priority_score DESC, blog_name COLLATE NOCASE, blog_id, kind, slot_no`
  ).bind(planDate).all();
  return rows.results || [];
}
