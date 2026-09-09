import { callHub } from './api-hub.js';

const DEFAULT_LIMIT = 2;
const BLOGGER_LIST_LIMIT = 100;
const VISIBILITY_GRACE_MINUTES = 5;
const MATCH_LOOKBACK_MINUTES = 60;
const MATCH_FUTURE_SKEW_MINUTES = 10;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) return null;
  return env.ORCHESTRATOR_DB;
}

function positiveLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error('AMBIGUOUS_PUBLICATION_LIMIT_INVALID');
  return number;
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function utcDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function postDate(post) {
  return utcDate(post?.published || post?.updated || null);
}

export function normalizePublicationTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function findRecentExactTitleMatches(posts, expectedTitle, lowerBound, upperBound) {
  const wanted = normalizePublicationTitle(expectedTitle);
  if (!wanted) return [];
  const min = lowerBound instanceof Date ? lowerBound.getTime() : utcDate(lowerBound)?.getTime();
  const max = upperBound instanceof Date ? upperBound.getTime() : utcDate(upperBound)?.getTime();
  return (Array.isArray(posts) ? posts : []).filter((post) => {
    if (normalizePublicationTitle(post?.title) !== wanted) return false;
    const when = postDate(post)?.getTime();
    if (!Number.isFinite(when)) return false;
    if (Number.isFinite(min) && when < min) return false;
    if (Number.isFinite(max) && when > max) return false;
    return Boolean(String(post?.bloggerPostId || '').trim());
  });
}

export function listingCoversRelevantWindow(listing, lowerBound) {
  if (!listing?.truncated) return true;
  const lower = lowerBound instanceof Date ? lowerBound.getTime() : utcDate(lowerBound)?.getTime();
  if (!Number.isFinite(lower)) return false;
  const dated = (Array.isArray(listing?.posts) ? listing.posts : [])
    .map((post) => postDate(post)?.getTime())
    .filter(Number.isFinite);
  if (dated.length === 0) return false;
  return Math.min(...dated) <= lower;
}

export function ambiguousPublicationVisibilityDue(scheduledTime, now = new Date(), graceMinutes = VISIBILITY_GRACE_MINUTES) {
  const scheduled = utcDate(scheduledTime);
  if (!scheduled) return true;
  return now.getTime() >= scheduled.getTime() + Number(graceMinutes) * 60_000;
}

function expectedTitle(result) {
  return String(result?.article?.title || result?.article?.headline || result?.title || '').trim();
}

function imagePipelineReady(result, imageSummary) {
  const total = Number(imageSummary?.total || 0);
  const attached = Number(imageSummary?.attached || 0);
  const incomplete = Number(imageSummary?.incomplete || 0);
  if (total > 0) return attached === total && incomplete === 0;
  const complete = result?.imagePipeline?.complete;
  if (complete === true || Number(complete) === 1) return true;
  return result?.imagePipeline == null;
}

async function listCandidates(env, limit) {
  const db = requireDb(env);
  if (!db) return [];
  const rows = await db.prepare(
    `SELECT p.job_id, p.blog_id, p.status AS publication_status, p.scheduled_time,
            p.created_at AS publication_created_at, p.updated_at AS publication_updated_at,
            p.attempts, p.error AS publication_error,
            j.status AS job_status, j.result_json, j.error AS job_error
       FROM job_publications p
       JOIN jobs j ON j.id = p.job_id
      WHERE p.status = 'failed'
        AND (p.blogger_post_id IS NULL OR p.blogger_post_id = '')
        AND (
          UPPER(COALESCE(p.error, '')) LIKE '%BLOGGER_WRITE_OUTCOME_UNKNOWN%'
          OR UPPER(COALESCE(p.error, '')) LIKE '%STALE_PUBLICATION_CLAIM%'
          OR UPPER(COALESCE(j.error, '')) LIKE '%BLOGGER_WRITE_OUTCOME_UNKNOWN%'
          OR UPPER(COALESCE(j.error, '')) LIKE '%STALE_PUBLICATION_CLAIM%'
        )
        AND j.mode = 'new_article'
        AND j.status IN ('failed', 'needs_review')
        AND j.archived_at IS NULL
      ORDER BY p.updated_at ASC, p.job_id ASC
      LIMIT ?`
  ).bind(limit).all();
  return rows.results || [];
}

async function imageSummary(env, jobId) {
  const db = requireDb(env);
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'attached' THEN 1 ELSE 0 END) AS attached,
            SUM(CASE WHEN status <> 'attached' THEN 1 ELSE 0 END) AS incomplete
       FROM job_images
      WHERE job_id = ?`
  ).bind(Number(jobId)).first();
  return row || { total: 0, attached: 0, incomplete: 0 };
}

async function adoptExistingLivePost(env, row, match) {
  const db = requireDb(env);
  const postId = String(match?.bloggerPostId || '').trim();
  if (!postId) throw new Error('AMBIGUOUS_PUBLICATION_MATCH_ID_MISSING');
  const url = String(match?.url || '').trim() || null;
  const results = await db.batch([
    db.prepare(
      `UPDATE job_publications
          SET status = 'published', blogger_post_id = ?, url = ?, error = NULL,
              attempts = 0, updated_at = datetime('now')
        WHERE job_id = ? AND status = 'failed'
          AND (blogger_post_id IS NULL OR blogger_post_id = '')`
    ).bind(postId, url, Number(row.job_id)),
    db.prepare(
      `UPDATE jobs
          SET status = 'publishing_new', error = NULL, recovery_state = 'none',
              next_retry_at = NULL, hold_reason = NULL, last_error_code = NULL,
              last_failure_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND status IN ('failed', 'needs_review') AND archived_at IS NULL`
    ).bind(Number(row.job_id))
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1) {
    throw new Error('AMBIGUOUS_PUBLICATION_ADOPTION_RACE');
  }
  return { bloggerPostId: postId, url };
}

async function requeuePublicationOnly(env, row) {
  const db = requireDb(env);
  const results = await db.batch([
    db.prepare(
      `UPDATE job_publications
          SET status = 'failed', attempts = 2,
              error = 'BLOGGER_AMBIGUOUS_WRITE_NOT_FOUND_SAFE_TO_RETRY',
              updated_at = datetime('now')
        WHERE job_id = ? AND status = 'failed'
          AND (blogger_post_id IS NULL OR blogger_post_id = '')`
    ).bind(Number(row.job_id)),
    db.prepare(
      `UPDATE jobs
          SET status = 'ready', error = NULL, recovery_state = 'none',
              next_retry_at = NULL, hold_reason = NULL, last_error_code = NULL,
              last_failure_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND status IN ('failed', 'needs_review') AND archived_at IS NULL`
    ).bind(Number(row.job_id)),
    db.prepare(
      `UPDATE daily_plan_slots
          SET recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
              last_error_code = NULL, last_failure_at = NULL, updated_at = datetime('now')
        WHERE job_id = ?`
    ).bind(Number(row.job_id))
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1 || Number(results?.[1]?.meta?.changes || 0) !== 1) {
    throw new Error('AMBIGUOUS_PUBLICATION_REQUEUE_RACE');
  }
}

export async function reconcileAmbiguousPublicationWrites(env, options = {}) {
  if (!requireDb(env)) {
    return { ok: true, checked: 0, adopted: 0, requeued: 0, waiting: 0, held: 0, failed: 0, items: [] };
  }
  const limit = positiveLimit(options.limit, DEFAULT_LIMIT);
  const now = options.now || new Date();
  const callHubFn = options.callHubFn || callHub;
  const rows = await listCandidates(env, limit);
  const items = [];

  for (const row of rows) {
    const result = safeResult(row.result_json) || {};
    const title = expectedTitle(result);
    if (!title || result?.status !== 'READY' || !result?.article || typeof result.article !== 'object') {
      items.push({ jobId: Number(row.job_id), status: 'held', reason: 'AMBIGUOUS_PUBLICATION_RESULT_NOT_READY' });
      continue;
    }

    if (!ambiguousPublicationVisibilityDue(row.scheduled_time, now)) {
      items.push({ jobId: Number(row.job_id), status: 'waiting', reason: 'BLOGGER_SCHEDULED_VISIBILITY_GRACE' });
      continue;
    }

    const createdAt = utcDate(row.publication_created_at) || utcDate(row.publication_updated_at) || now;
    const lowerBound = new Date(createdAt.getTime() - MATCH_LOOKBACK_MINUTES * 60_000);
    const upperBound = new Date(now.getTime() + MATCH_FUTURE_SKEW_MINUTES * 60_000);

    try {
      const listing = await callHubFn(
        env,
        env.HUB_BLOGGER_POSTS_PATH || '/api/blogger/posts',
        { blogId: String(row.blog_id), limit: BLOGGER_LIST_LIMIT }
      );
      const posts = Array.isArray(listing?.posts) ? listing.posts : [];
      const matches = findRecentExactTitleMatches(posts, title, lowerBound, upperBound);

      if (matches.length === 1) {
        const adopted = await adoptExistingLivePost(env, row, matches[0]);
        items.push({ jobId: Number(row.job_id), status: 'adopted', ...adopted });
        continue;
      }
      if (matches.length > 1) {
        items.push({ jobId: Number(row.job_id), status: 'held', reason: 'AMBIGUOUS_PUBLICATION_MULTIPLE_TITLE_MATCHES', matchCount: matches.length });
        continue;
      }
      if (!listingCoversRelevantWindow(listing, lowerBound)) {
        items.push({ jobId: Number(row.job_id), status: 'held', reason: 'BLOGGER_POST_LIST_WINDOW_NOT_COVERED' });
        continue;
      }

      const images = await imageSummary(env, row.job_id);
      if (!imagePipelineReady(result, images)) {
        items.push({ jobId: Number(row.job_id), status: 'held', reason: 'AMBIGUOUS_PUBLICATION_IMAGES_NOT_READY' });
        continue;
      }

      // The live Blogger listing covers the complete relevant window and contains
      // no exact-title match. Only the publication checkpoint is reopened. The
      // final article/result JSON and every attached KIE image row remain untouched.
      await requeuePublicationOnly(env, row);
      items.push({ jobId: Number(row.job_id), status: 'requeued', reason: 'PUBLICATION_ONLY_RETRY_SAFE' });
    } catch (error) {
      items.push({
        jobId: Number(row.job_id),
        status: 'failed',
        reason: String(error?.code || error?.message || 'AMBIGUOUS_PUBLICATION_RECOVERY_FAILED').slice(0, 120)
      });
    }
  }

  return {
    ok: items.every((item) => item.status !== 'failed'),
    checked: rows.length,
    adopted: items.filter((item) => item.status === 'adopted').length,
    requeued: items.filter((item) => item.status === 'requeued').length,
    waiting: items.filter((item) => item.status === 'waiting').length,
    held: items.filter((item) => item.status === 'held').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items
  };
}
