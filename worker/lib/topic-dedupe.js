import { classifySearchIntent } from './topic-candidates.js';
import { topicSimilarity } from './content-strategy.js';

const ACTIVE_OR_PUBLISHED_JOB_STATES = new Set([
  'queued', 'writing', 'critic_review', 'repairing', 'final_critic',
  'ready', 'publishing_new', 'completed', 'needs_review'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseTitle(resultJson) {
  try {
    const result = JSON.parse(String(resultJson || ''));
    return String(result?.article?.title || '').trim();
  } catch {
    return '';
  }
}

function conflictScore(leftTopic, leftTitle, rightTopic, rightTitle) {
  const pairs = [
    [leftTopic, rightTopic],
    [leftTopic, rightTitle],
    [leftTitle, rightTopic],
    [leftTitle, rightTitle]
  ].filter(([a, b]) => String(a || '').trim() && String(b || '').trim());
  let score = 0;
  for (const [a, b] of pairs) {
    if (normalize(a) === normalize(b)) return 1;
    score = Math.max(score, topicSimilarity(a, b));
  }
  return Number(score.toFixed(4));
}

export async function findNewArticleTopicConflict(env, input = {}) {
  const db = requireDb(env);
  const blogId = String(input.blogId || '').trim();
  const topic = String(input.topic || '').trim();
  const title = String(input.title || '').trim();
  const threshold = Number.isFinite(Number(input.threshold)) ? Number(input.threshold) : 0.74;
  const excludeJobId = Number(input.excludeJobId || 0);
  const excludeCandidateId = Number(input.excludeCandidateId || 0);
  const maxJobId = Number(input.maxJobId || 0);
  if (!blogId || (!topic && !title)) return null;

  const jobs = await db.prepare(
    `SELECT id, topic, status, result_json
       FROM jobs
      WHERE mode = 'new_article' AND blog_id = ? AND topic IS NOT NULL AND topic <> ''
      ORDER BY id DESC
      LIMIT 400`
  ).bind(blogId).all();

  for (const row of jobs.results || []) {
    const jobId = Number(row.id || 0);
    if (!ACTIVE_OR_PUBLISHED_JOB_STATES.has(String(row.status || ''))) continue;
    if (excludeJobId > 0 && jobId === excludeJobId) continue;
    if (maxJobId > 0 && jobId >= maxJobId) continue;
    const existingTitle = parseTitle(row.result_json);
    const score = conflictScore(topic, title, row.topic, existingTitle);
    if (score >= threshold) {
      return {
        kind: 'job',
        id: jobId,
        topic: String(row.topic || ''),
        title: existingTitle || null,
        similarity: score,
        exact: score === 1
      };
    }
  }

  const publishedOnly = input.publishedCandidatesOnly === true;
  const candidates = await db.prepare(
    `SELECT id, query, status, target_page, claimed_job_id
       FROM topic_candidates
      WHERE blog_id = ? AND status IN ('reserved','used')
      ORDER BY id DESC
      LIMIT 400`
  ).bind(blogId).all();

  for (const row of candidates.results || []) {
    const candidateId = Number(row.id || 0);
    if (excludeCandidateId > 0 && candidateId === excludeCandidateId) continue;
    if (excludeJobId > 0 && Number(row.claimed_job_id || 0) === excludeJobId) continue;
    if (publishedOnly && !String(row.target_page || '').trim()) continue;
    const score = conflictScore(topic, title, row.query, '');
    if (score >= threshold) {
      return {
        kind: 'candidate',
        id: candidateId,
        topic: String(row.query || ''),
        targetPage: row.target_page || null,
        similarity: score,
        exact: score === 1
      };
    }
  }
  return null;
}

export async function reservePlannerTopicCandidate(env, input = {}) {
  const db = requireDb(env);
  const blogId = String(input.blogId || '').trim();
  const topic = String(input.topic || '').trim();
  if (!blogId || !topic) throw new Error('PLANNER_TOPIC_RESERVATION_INPUT_INVALID');

  const existing = await db.prepare(
    `SELECT id, status, target_page, claimed_job_id
       FROM topic_candidates
      WHERE blog_id = ? AND query = ? COLLATE NOCASE
      LIMIT 1`
  ).bind(blogId, topic).first();

  if (existing?.id) {
    if (String(existing.target_page || '').trim() || ['reserved', 'used'].includes(String(existing.status || ''))) {
      return { ok: false, reason: 'PLANNER_TOPIC_ALREADY_CLAIMED', candidateId: Number(existing.id) };
    }
    const claimed = await db.prepare(
      `UPDATE topic_candidates
          SET status = 'reserved', claimed_at = datetime('now'), claimed_job_id = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'candidate' AND target_page IS NULL`
    ).bind(Number(existing.id)).run();
    if (Number(claimed?.meta?.changes || 0) === 1) {
      return { ok: true, candidateId: Number(existing.id), source: 'planner' };
    }
    return { ok: false, reason: 'PLANNER_TOPIC_RESERVATION_RACE', candidateId: Number(existing.id) };
  }

  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO topic_candidates
      (blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position, opportunity_score,
       target_page, status, claimed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'planner', date('now'), 0, 0, 0, 0, 0, NULL, 'reserved', datetime('now'), datetime('now'), datetime('now'))`
  ).bind(blogId, topic, classifySearchIntent(topic)).run();
  if (Number(inserted?.meta?.changes || 0) !== 1) {
    const collision = await db.prepare('SELECT id FROM topic_candidates WHERE blog_id = ? AND query = ? COLLATE NOCASE LIMIT 1')
      .bind(blogId, topic).first();
    return { ok: false, reason: 'PLANNER_TOPIC_RESERVATION_RACE', candidateId: Number(collision?.id || 0) || null };
  }
  const stored = await db.prepare('SELECT id FROM topic_candidates WHERE blog_id = ? AND query = ? COLLATE NOCASE LIMIT 1')
    .bind(blogId, topic).first();
  if (!stored?.id) throw new Error('PLANNER_TOPIC_RESERVATION_STORE_FAILED');
  return { ok: true, candidateId: Number(stored.id), source: 'planner' };
}

export async function rejectDuplicateTopicCandidate(env, candidateId) {
  const id = Number(candidateId || 0);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await requireDb(env).prepare(
    `UPDATE topic_candidates
        SET status = 'rejected', claimed_at = NULL, claimed_job_id = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'reserved' AND claimed_job_id IS NULL`
  ).bind(id).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function cleanupReadyDuplicateNewArticles(env, options = {}) {
  const db = requireDb(env);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
  const rows = await db.prepare(
    `SELECT id, blog_id, topic, result_json
       FROM jobs
      WHERE mode = 'new_article' AND status = 'ready' AND archived_at IS NULL
      ORDER BY id ASC
      LIMIT ?`
  ).bind(limit).all();
  const blocked = [];

  for (const row of rows.results || []) {
    const jobId = Number(row.id || 0);
    const conflict = await findNewArticleTopicConflict(env, {
      blogId: String(row.blog_id || ''),
      topic: String(row.topic || ''),
      title: parseTitle(row.result_json),
      excludeJobId: jobId,
      maxJobId: jobId,
      publishedCandidatesOnly: true,
      threshold: 0.74
    });
    if (!conflict) continue;
    const result = await db.prepare(
      `UPDATE jobs
          SET status = 'needs_review', error = 'DUPLICATE_TOPIC_PUBLICATION_BLOCKED',
              last_error_code = 'DUPLICATE_TOPIC_PUBLICATION_BLOCKED',
              recovery_state = 'held', hold_reason = 'DUPLICATE_TOPIC_PUBLICATION_BLOCKED',
              next_retry_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'ready' AND archived_at IS NULL`
    ).bind(jobId).run();
    if (Number(result?.meta?.changes || 0) === 1) {
      blocked.push({ jobId, blogId: String(row.blog_id || ''), conflict });
    }
  }

  return { ok: true, checked: (rows.results || []).length, blocked: blocked.length, items: blocked };
}
