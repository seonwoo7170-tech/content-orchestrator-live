import { callHub } from './api-hub.js';

const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 20;
const INVENTORY_LIMIT = 100;
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
const NO_MATCH_GRACE_MS = 2 * 60 * 1000;
const AMBIGUOUS_ERRORS = ['BLOGGER_WRITE_OUTCOME_UNKNOWN', 'STALE_PUBLICATION_CLAIM'];

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function positiveLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) throw new Error('PUBLICATION_AMBIGUITY_LIMIT_INVALID');
  return number;
}

function parseResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeVisibleText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function dbTime(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(text);
  const parsed = Date.parse(hasZone ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ambiguousCode(...values) {
  const text = values.map((value) => String(value || '').toUpperCase()).join('|');
  return AMBIGUOUS_ERRORS.some((code) => text.includes(code));
}

function metadataTime(post) {
  return Date.parse(String(post?.updated || post?.published || '')) || 0;
}

function matchingMetadata(row, result, posts = []) {
  const title = normalizeTitle(result?.article?.title || row.topic);
  const attemptedAt = dbTime(row.publication_updated_at || row.updated_at);
  if (!title || !attemptedAt) return [];
  return posts
    .filter((post) => normalizeTitle(post?.title) === title)
    .map((post) => ({ ...post, _time: metadataTime(post) }))
    .filter((post) => post._time && Math.abs(post._time - attemptedAt) <= MATCH_WINDOW_MS)
    .sort((a, b) => Math.abs(a._time - attemptedAt) - Math.abs(b._time - attemptedAt));
}

function contentMatches(expectedHtml, readback) {
  const expected = normalizeVisibleText(expectedHtml);
  const actual = normalizeVisibleText(readback?.article?.html);
  if (!expected || !actual || expected.length < 80 || actual.length < 80) return false;
  return expected === actual;
}

async function listAmbiguousRows(env, options) {
  const db = requireDb(env);
  const jobId = Number(options?.jobId || 0);
  const limit = positiveLimit(options?.limit, jobId > 0 ? 1 : DEFAULT_LIMIT);
  const whereJob = jobId > 0 ? 'AND j.id = ?' : '';
  const statement = db.prepare(
    `SELECT j.id, j.mode, j.blog_id, j.topic, j.status, j.result_json, j.updated_at,
            p.status AS publication_status, p.blogger_post_id, p.url AS publication_url,
            p.error AS publication_error, p.scheduled_time, p.updated_at AS publication_updated_at
       FROM jobs j
       JOIN job_publications p ON p.job_id = j.id
      WHERE j.archived_at IS NULL
        AND j.mode = 'new_article'
        AND j.status IN ('failed', 'needs_review')
        AND p.status = 'failed'
        AND (p.blogger_post_id IS NULL OR p.blogger_post_id = '')
        AND (
          UPPER(COALESCE(j.last_error_code, j.error, '')) LIKE '%BLOGGER_WRITE_OUTCOME_UNKNOWN%'
          OR UPPER(COALESCE(j.last_error_code, j.error, '')) LIKE '%STALE_PUBLICATION_CLAIM%'
          OR UPPER(COALESCE(p.error, '')) LIKE '%BLOGGER_WRITE_OUTCOME_UNKNOWN%'
          OR UPPER(COALESCE(p.error, '')) LIKE '%STALE_PUBLICATION_CLAIM%'
        )
        ${whereJob}
      ORDER BY p.updated_at ASC, j.id ASC
      LIMIT ?`
  );
  const rows = jobId > 0
    ? await statement.bind(jobId, limit).all()
    : await statement.bind(limit).all();
  return rows.results || [];
}

async function holdForReview(env, row, code, post = null) {
  const db = requireDb(env);
  const postId = String(post?.bloggerPostId || '').trim() || null;
  const url = post?.url || null;
  await db.batch([
    db.prepare(
      `UPDATE job_publications
          SET blogger_post_id = COALESCE(?, blogger_post_id),
              url = COALESCE(?, url),
              error = ?,
              updated_at = datetime('now')
        WHERE job_id = ? AND status = 'failed'`
    ).bind(postId, url, code, Number(row.id)),
    db.prepare(
      `UPDATE jobs
          SET status = 'needs_review', error = ?, last_error_code = ?, recovery_state = 'held',
              hold_reason = ?, next_retry_at = NULL, last_failure_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL AND status IN ('failed', 'needs_review')`
    ).bind(code, code, code, Number(row.id)),
    db.prepare(
      `UPDATE daily_plan_slots
          SET recovery_state = 'held', hold_reason = ?, last_error_code = ?, next_retry_at = NULL,
              last_failure_at = datetime('now'), updated_at = datetime('now')
        WHERE job_id = ?`
    ).bind(code, code, Number(row.id))
  ]);
  return { jobId: Number(row.id), status: 'needs_review', action: 'held', reason: code, bloggerPostId: postId, url };
}

async function adoptExistingPublication(env, row, post, readback) {
  const db = requireDb(env);
  const bloggerStatus = String(readback?.identity?.status || post?.status || '').trim().toLowerCase();
  if (!['live', 'scheduled'].includes(bloggerStatus)) {
    return holdForReview(env, row, 'BLOGGER_DRAFT_RECOVERY_REQUIRED', post);
  }
  const publicationStatus = bloggerStatus === 'live' ? 'published' : 'scheduled';
  const postId = String(readback?.identity?.bloggerPostId || post?.bloggerPostId || '').trim();
  const url = readback?.identity?.permalink || post?.url || null;
  if (!postId) return holdForReview(env, row, 'BLOGGER_PUBLICATION_MATCH_ID_MISSING', post);

  await db.batch([
    db.prepare(
      `UPDATE job_publications
          SET status = ?, blogger_post_id = ?, url = ?, error = NULL, updated_at = datetime('now')
        WHERE job_id = ? AND status = 'failed' AND (blogger_post_id IS NULL OR blogger_post_id = '')`
    ).bind(publicationStatus, postId, url, Number(row.id)),
    db.prepare(
      `UPDATE jobs
          SET status = 'publishing_new', error = NULL, last_error_code = NULL,
              recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
              last_failure_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL AND status IN ('failed', 'needs_review')`
    ).bind(Number(row.id)),
    db.prepare(
      `UPDATE daily_plan_slots
          SET recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
              last_error_code = NULL, last_failure_at = NULL, updated_at = datetime('now')
        WHERE job_id = ?`
    ).bind(Number(row.id))
  ]);
  return {
    jobId: Number(row.id),
    status: 'adopted',
    action: 'adopted_existing',
    bloggerStatus,
    bloggerPostId: postId,
    url
  };
}

async function requeuePublishOnly(env, row) {
  const db = requireDb(env);
  await db.batch([
    db.prepare(
      `DELETE FROM job_publications
        WHERE job_id = ? AND status = 'failed' AND (blogger_post_id IS NULL OR blogger_post_id = '')`
    ).bind(Number(row.id)),
    db.prepare(
      `UPDATE jobs
          SET status = 'ready', error = NULL, retry_count = 0, recovery_state = 'none',
              next_retry_at = NULL, hold_reason = NULL, last_error_code = NULL,
              last_failure_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL AND status IN ('failed', 'needs_review')`
    ).bind(Number(row.id)),
    db.prepare(
      `UPDATE daily_plan_slots
          SET retry_count = 0, recovery_state = 'none', next_retry_at = NULL,
              hold_reason = NULL, last_error_code = NULL, last_failure_at = NULL,
              updated_at = datetime('now')
        WHERE job_id = ?`
    ).bind(Number(row.id))
  ]);
  return {
    jobId: Number(row.id),
    status: 'ready',
    action: 'requeued_publish_only',
    preserveResult: true,
    preserveImages: true,
    runRequired: false
  };
}

async function inspectRow(env, row, options) {
  const result = parseResult(row.result_json);
  if (!result?.article?.html || !result?.article?.title) {
    return holdForReview(env, row, 'PUBLICATION_RECOVERY_RESULT_MISSING');
  }
  if (!ambiguousCode(row.publication_error, row.error, row.last_error_code)) {
    return { jobId: Number(row.id), status: 'skipped', action: 'not_ambiguous' };
  }

  const callHubFn = options.callHubFn || callHub;
  let inventory;
  try {
    inventory = await callHubFn(
      env,
      env.HUB_BLOGGER_POSTS_PATH || '/api/blogger/posts',
      { blogId: String(row.blog_id), limit: INVENTORY_LIMIT, statuses: ['live', 'scheduled', 'draft'] }
    );
  } catch (error) {
    return { jobId: Number(row.id), status: 'pending', action: 'inventory_retry', reason: String(error?.message || 'BLOGGER_INVENTORY_FAILED').slice(0, 180) };
  }

  const metadata = matchingMetadata(row, result, Array.isArray(inventory?.posts) ? inventory.posts : []);
  const strong = [];
  for (const post of metadata.slice(0, 6)) {
    const postId = String(post?.bloggerPostId || '').trim();
    if (!postId) continue;
    try {
      const readback = await callHubFn(
        env,
        env.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
        { blogId: String(row.blog_id), bloggerPostId: postId }
      );
      const idMatches = String(readback?.identity?.bloggerPostId || '') === postId;
      const titleMatches = normalizeTitle(readback?.article?.title) === normalizeTitle(result.article.title);
      if (idMatches && titleMatches && contentMatches(result.article.html, readback)) {
        strong.push({ post, readback });
      }
    } catch { /* a single stale metadata row is not enough to authorize a write */ }
  }

  if (strong.length === 1) return adoptExistingPublication(env, row, strong[0].post, strong[0].readback);
  if (strong.length > 1) return holdForReview(env, row, 'BLOGGER_PUBLICATION_MATCH_AMBIGUOUS');
  if (metadata.length > 0) return holdForReview(env, row, 'BLOGGER_PUBLICATION_CANDIDATE_UNVERIFIED');

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const attemptedAt = dbTime(row.publication_updated_at || row.updated_at);
  if (!attemptedAt || now.getTime() - attemptedAt < NO_MATCH_GRACE_MS) {
    return { jobId: Number(row.id), status: 'pending', action: 'grace_period', reason: 'BLOGGER_PUBLICATION_REVIEW_GRACE_PERIOD' };
  }
  return requeuePublishOnly(env, row);
}

export async function recoverAmbiguousPublications(env, options = {}) {
  if (!env?.ORCHESTRATOR_DB) return { ok: true, checked: 0, adopted: 0, requeued: 0, held: 0, pending: 0, items: [] };
  const rows = await listAmbiguousRows(env, options);
  const items = [];
  for (const row of rows) items.push(await inspectRow(env, row, options));
  return {
    ok: items.every((item) => item.status !== 'needs_review'),
    checked: rows.length,
    adopted: items.filter((item) => item.action === 'adopted_existing').length,
    requeued: items.filter((item) => item.action === 'requeued_publish_only').length,
    held: items.filter((item) => item.action === 'held').length,
    pending: items.filter((item) => item.status === 'pending').length,
    items
  };
}

export const publicationAmbiguityInternals = {
  normalizeTitle,
  normalizeVisibleText,
  contentMatches,
  matchingMetadata,
  dbTime
};
