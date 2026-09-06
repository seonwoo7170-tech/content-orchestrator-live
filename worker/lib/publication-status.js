import { callHub } from './api-hub.js';

const LIVE_RECONCILE_LIMIT = 4;
const LIVE_RECHECK_MINUTES = 2;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safePublicationError(value) {
  const code = String(value || '').split(/[:\s]/)[0].toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 80);
  return code || null;
}

export function publicationDisplayStatus(storedStatus, scheduledAt, now = new Date()) {
  const status = String(storedStatus || '');
  if (status !== 'scheduled') return status;
  const scheduledTime = Date.parse(String(scheduledAt || ''));
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (Number.isFinite(scheduledTime) && Number.isFinite(nowTime) && scheduledTime <= nowTime) return 'verification_pending';
  return status;
}

function publicRow(row, now) {
  let result = null;
  try { result = row.result_json ? JSON.parse(String(row.result_json)) : null; } catch { result = null; }
  const errorCode = safePublicationError(row.publication_error);
  const status = publicationDisplayStatus(row.publication_status, row.scheduled_time, now);
  return {
    jobId: Number(row.job_id),
    blogId: String(row.blog_id),
    blogName: row.blog_name || null,
    kind: row.kind || (row.mode === 'repair_existing' ? 'repair_existing' : 'new_article'),
    title: result?.article?.title || row.topic || null,
    status,
    scheduledAt: row.scheduled_time || null,
    bloggerPostId: row.blogger_post_id || null,
    url: row.url || row.target_url || result?.identity?.permalink || null,
    jobStatus: row.job_status || null,
    errorCode,
    attentionRequired: row.publication_status === 'failed' || errorCode === 'BLOGGER_WRITE_OUTCOME_UNKNOWN' || errorCode === 'STALE_PUBLICATION_CLAIM_HELD'
  };
}

function bloggerStatus(readback) {
  return String(readback?.identity?.status || '').trim().toUpperCase();
}

async function defaultDueScheduledRows(env, planDate, now, limit) {
  const result = await requireDb(env).prepare(
    `SELECT job_id, blog_id, blogger_post_id, scheduled_time, updated_at
     FROM job_publications
     WHERE plan_date = ?
       AND status = 'scheduled'
       AND blogger_post_id IS NOT NULL
       AND trim(blogger_post_id) <> ''
       AND datetime(scheduled_time) <= datetime(?)
       AND datetime(updated_at) <= datetime(?, '-${LIVE_RECHECK_MINUTES} minutes')
     ORDER BY scheduled_time, job_id
     LIMIT ?`
  ).bind(String(planDate), now.toISOString(), now.toISOString(), Number(limit)).all();
  return result.results || [];
}

async function defaultMarkChecked(env, row, readback, isLive) {
  const db = requireDb(env);
  if (isLive) {
    const url = readback?.identity?.permalink || null;
    const result = await db.prepare(
      `UPDATE job_publications
       SET status = 'published', url = COALESCE(?, url), error = NULL, updated_at = datetime('now')
       WHERE job_id = ? AND status = 'scheduled' AND blogger_post_id = ?`
    ).bind(url, Number(row.job_id), String(row.blogger_post_id)).run();
    return Number(result?.meta?.changes || 0) === 1;
  }
  await db.prepare(
    `UPDATE job_publications
     SET updated_at = datetime('now')
     WHERE job_id = ? AND status = 'scheduled' AND blogger_post_id = ?`
  ).bind(Number(row.job_id), String(row.blogger_post_id)).run();
  return false;
}

export async function reconcileDueScheduledPublications(env, planDate, options = {}) {
  const date = String(planDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('PUBLICATION_STATUS_DATE_INVALID');
  const now = options.now || new Date();
  const limit = Math.max(1, Math.min(10, Number(options.limit || LIVE_RECONCILE_LIMIT)));
  const listDueFn = options.listDueFn || defaultDueScheduledRows;
  const markCheckedFn = options.markCheckedFn || defaultMarkChecked;
  const callHubFn = options.callHubFn || callHub;
  const rows = await listDueFn(env, date, now, limit);
  let checked = 0;
  let published = 0;
  let pending = 0;

  for (const row of rows) {
    checked += 1;
    let readback = null;
    try {
      readback = await callHubFn(
        env,
        env.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
        {
          blogId: String(row.blog_id),
          bloggerPostId: String(row.blogger_post_id)
        }
      );
    } catch {
      await markCheckedFn(env, row, null, false).catch(() => false);
      pending += 1;
      continue;
    }

    const isLive = bloggerStatus(readback) === 'LIVE';
    const changed = await markCheckedFn(env, row, readback, isLive);
    if (isLive && changed !== false) published += 1;
    else if (!isLive) pending += 1;
  }

  return { checked, published, pending };
}

export async function listPublicationStatus(env, planDate, options = {}) {
  const date = String(planDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('PUBLICATION_STATUS_DATE_INVALID');
  const now = options.now || new Date();
  const allowedBlogIds = new Set((options.blogIds || []).map(String));
  const liveSync = options.reconcileLive === false
    ? { checked: 0, published: 0, pending: 0 }
    : await reconcileDueScheduledPublications(env, date, { ...options, now }).catch(() => ({ checked: 0, published: 0, pending: 0 }));
  const result = await requireDb(env).prepare(
    `SELECT p.job_id, p.blog_id, p.plan_date, p.slot_no, p.scheduled_time,
            p.status AS publication_status, p.blogger_post_id, p.url, p.error AS publication_error,
            j.mode, j.topic, j.target_url, j.status AS job_status, j.result_json,
            s.kind, s.blog_name
     FROM job_publications p
     JOIN jobs j ON j.id = p.job_id
     LEFT JOIN daily_plan_slots s ON s.job_id = p.job_id
     WHERE p.plan_date = ?
     ORDER BY p.scheduled_time, p.blog_id, p.slot_no, p.job_id`
  ).bind(date).all();
  const rows = (result.results || [])
    .map((row) => publicRow(row, now))
    .filter((row) => allowedBlogIds.size === 0 || allowedBlogIds.has(row.blogId));
  const attentionRequired = rows.filter((row) => row.attentionRequired).length;
  return {
    planDate: date,
    count: rows.length,
    scheduledNew: rows.filter((row) => ['scheduled', 'published', 'verification_pending'].includes(row.status) && row.kind === 'new_article').length,
    repairActions: rows.filter((row) => ['scheduled_update', 'updated'].includes(row.status) && row.kind === 'repair_existing').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    attentionRequired,
    health: attentionRequired > 0 ? 'attention_required' : 'ok',
    liveSync,
    rows
  };
}
