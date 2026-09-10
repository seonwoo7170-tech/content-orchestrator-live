function optionalDb(env) {
  return env?.ORCHESTRATOR_DB || null;
}

function requireDb(env) {
  const db = optionalDb(env);
  if (!db) throw new Error('DB_NOT_BOUND');
  return db;
}

function normalizeJobId(value) {
  const jobId = Number(value);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('JOB_ID_INVALID');
  return jobId;
}

function normalizeLevel(value) {
  const level = String(value || 'info').trim().toLowerCase();
  return ['info', 'success', 'warn', 'error'].includes(level) ? level : 'info';
}

function normalizeLimit(value) {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

function isMissingTable(error) {
  return /no such table:\s*job_events/i.test(String(error?.message || error || ''));
}

export async function appendJobEvent(env, jobIdValue, event = {}) {
  const db = optionalDb(env);
  if (!db) return false;
  const jobId = normalizeJobId(jobIdValue);
  const eventType = String(event.eventType || 'status').trim().slice(0, 64) || 'status';
  const stage = String(event.stage || '').trim().slice(0, 64) || null;
  const message = String(event.message || '').trim().slice(0, 500);
  if (!message) return false;
  const metaJson = event.meta && typeof event.meta === 'object'
    ? JSON.stringify(event.meta).slice(0, 3000)
    : null;
  try {
    await db.prepare(
      `INSERT INTO job_events (job_id, level, event_type, stage, message, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(jobId, normalizeLevel(event.level), eventType, stage, message, metaJson).run();
    return true;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function listJobEvents(env, jobIdValue, options = {}) {
  const db = requireDb(env);
  const jobId = normalizeJobId(jobIdValue);
  const afterId = Math.max(0, Number.parseInt(String(options.afterId ?? 0), 10) || 0);
  const limit = normalizeLimit(options.limit);
  try {
    const result = await db.prepare(
      `SELECT id, job_id, level, event_type, stage, message, meta_json, created_at
         FROM job_events
        WHERE job_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`
    ).bind(jobId, afterId, limit).all();
    return (result.results || []).map((row) => {
      let meta = null;
      try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
      return { ...row, meta, meta_json: undefined };
    });
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}
