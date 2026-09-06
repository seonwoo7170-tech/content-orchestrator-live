import { buildDailySlots } from './daily-plan.js';

const ACTIVE_JOB_STATES = new Set([
  'queued', 'writing', 'critic_review', 'repairing', 'final_critic',
  'updating_existing', 'publishing_new'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function workCap(value, enabled) {
  if (enabled === false) return 0;
  return Math.max(0, Math.min(10, nonNegativeInteger(value)));
}

function normalizedSignals(signals = {}) {
  return {
    active: nonNegativeInteger(signals.active),
    failed: nonNegativeInteger(signals.failed),
    needsReview: nonNegativeInteger(signals.needsReview),
    retryWait: nonNegativeInteger(signals.retryWait),
    held: nonNegativeInteger(signals.held)
  };
}

function decisionBase(blog, effective, signals) {
  const blogId = String(blog?.blogId || blog?.id || '').trim();
  if (!blogId) throw new Error('ADAPTIVE_WORKLOAD_BLOG_ID_REQUIRED');
  const operationMode = String(effective?.operationMode || 'validation');
  return {
    blogId,
    blogName: blog?.name || `Blog ${blogId}`,
    operationMode,
    postsTotal: nonNegativeInteger(blog?.postsTotal),
    signals: normalizedSignals(signals)
  };
}

function attentionReasons(signals = {}) {
  const reasons = [];
  if (signals.held > 0) reasons.push('HELD_WORK_PRESENT');
  if (signals.needsReview > 0) reasons.push('REVIEW_WORK_PRESENT');
  if (signals.retryWait > 0 || signals.failed > 0) reasons.push('RECOVERY_WORK_PRESENT');
  if (signals.active >= 3) reasons.push('ACTIVE_PIPELINE_BACKLOG_PRESENT');
  if (reasons.length) reasons.push('HISTORICAL_ATTENTION_NONBLOCKING');
  return reasons;
}

export function deriveAdaptiveWorkloadDecision({ blog = {}, effective = {}, signals = {} } = {}) {
  const base = decisionBase(blog, effective, signals);
  const newCap = workCap(effective?.newArticlesPerDay, effective?.newArticlesEnabled);
  const repairCap = workCap(effective?.repairsPerDay, effective?.repairsEnabled);
  const reasons = attentionReasons(base.signals);

  const finish = (priorityScore, priorityLabel, newArticles, repairs, extraReasons = []) => ({
    ...base,
    priorityScore,
    priorityLabel,
    newArticles: Math.min(newCap, Math.max(0, Number(newArticles) || 0)),
    repairs: Math.min(repairCap, Math.max(0, Number(repairs) || 0)),
    configuredCaps: { newArticles: newCap, repairs: repairCap },
    reasons: [...reasons, ...extraReasons]
  });

  if (effective?.enabled === false) {
    return finish(0, 'paused', 0, 0, ['AUTOMATION_DISABLED']);
  }

  // Recovery/review/held rows are separate queue items. They must remain visible to recovery
  // diagnostics, but they must never turn today's explicitly configured 2+2 (or other) target
  // into 0+0. Each new daily slot has its own bounded execution/recovery and publication gates.
  const repairs = base.postsTotal <= 0 ? 0 : repairCap;
  if (base.postsTotal <= 0) reasons.push('NO_LIVE_POSTS', 'REPAIR_TARGET_NOT_APPLICABLE');
  reasons.push('USER_DAILY_TARGET_PRESERVED', 'REPAIR_CAP_APPLIED_IF_CANDIDATE_EXISTS');

  if (base.operationMode === 'recovery') {
    return finish(82, 'recovery_target', newCap, repairs, ['RECOVERY_MODE']);
  }

  if (base.operationMode === 'growth') {
    const score = base.postsTotal < 20 ? 85 : 78;
    return finish(score, base.postsTotal < 20 ? 'growth_bootstrap_target' : 'growth_target', newCap, repairs, [
      'GROWTH_MODE',
      base.postsTotal < 20 ? 'LOW_POST_COUNT_GROWTH_PRIORITY' : 'STEADY_GROWTH_PRIORITY'
    ]);
  }

  return finish(72, 'validation_target', newCap, repairs, ['VALIDATION_MODE']);
}

export function failedJobBlocksWork(row = {}, planDate = '') {
  if (String(row.status || '') !== 'failed') return false;
  const recoveryState = String(row.recovery_state ?? row.recoveryState ?? 'none');
  if (recoveryState === 'retry_wait' || recoveryState === 'held') return true;
  const date = String(planDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const updated = String(row.updated_at ?? row.updatedAt ?? '').slice(0, 10);
  return updated === date;
}

async function operationalSignalsByBlog(env, planDate) {
  const result = await requireDb(env).prepare(
    `SELECT blog_id, status, recovery_state, updated_at, COUNT(*) AS count
     FROM jobs
     WHERE blog_id IS NOT NULL AND blog_id <> '' AND status <> 'completed'
     GROUP BY blog_id, status, recovery_state, updated_at`
  ).all();
  const map = new Map();
  for (const row of result.results || []) {
    const blogId = String(row.blog_id || '');
    if (!map.has(blogId)) map.set(blogId, { active: 0, failed: 0, needsReview: 0, retryWait: 0, held: 0 });
    const signal = map.get(blogId);
    const count = nonNegativeInteger(row.count);
    const status = String(row.status || '');
    const recoveryState = String(row.recovery_state || 'none');
    if (ACTIVE_JOB_STATES.has(status)) signal.active += count;
    if (failedJobBlocksWork(row, planDate)) signal.failed += count;
    if (status === 'needs_review') signal.needsReview += count;
    if (recoveryState === 'retry_wait') signal.retryWait += count;
    if (recoveryState === 'held') signal.held += count;
  }
  return map;
}

function parseJson(value, code) {
  try { return JSON.parse(String(value || '[]')); } catch { throw new Error(code); }
}

export async function listAdaptiveWorkloadDecisions(env, planDate) {
  const date = String(planDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ADAPTIVE_WORKLOAD_PLAN_DATE_INVALID');
  const result = await requireDb(env).prepare(
    `SELECT plan_date, blog_id, blog_name, operation_mode, priority_score, priority_label,
            new_articles, repairs, signals_json, reasons_json, created_at, updated_at
     FROM daily_blog_workload_decisions
     WHERE plan_date = ?
     ORDER BY priority_score DESC, blog_name COLLATE NOCASE, blog_id`
  ).bind(date).all();
  const decisions = (result.results || []).map((row) => ({
    planDate: row.plan_date,
    blogId: String(row.blog_id),
    blogName: row.blog_name || null,
    operationMode: row.operation_mode,
    priorityScore: Number(row.priority_score || 0),
    priorityLabel: row.priority_label,
    newArticles: Number(row.new_articles || 0),
    repairs: Number(row.repairs || 0),
    signals: parseJson(row.signals_json, 'ADAPTIVE_WORKLOAD_SIGNALS_JSON_INVALID'),
    reasons: parseJson(row.reasons_json, 'ADAPTIVE_WORKLOAD_REASONS_JSON_INVALID'),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }));
  return { planDate: date, decisions, count: decisions.length };
}

async function persistCurrentDecisions(env, planDate, decisions) {
  if (!decisions.length) return 0;
  const statements = decisions.map((decision) => requireDb(env).prepare(
    `INSERT INTO daily_blog_workload_decisions
      (plan_date, blog_id, blog_name, operation_mode, priority_score, priority_label,
       new_articles, repairs, signals_json, reasons_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(plan_date, blog_id) DO UPDATE SET
       blog_name = excluded.blog_name,
       operation_mode = excluded.operation_mode,
       priority_score = excluded.priority_score,
       priority_label = excluded.priority_label,
       new_articles = excluded.new_articles,
       repairs = excluded.repairs,
       signals_json = excluded.signals_json,
       reasons_json = excluded.reasons_json,
       updated_at = datetime('now')`
  ).bind(
    planDate,
    decision.blogId,
    decision.blogName || null,
    decision.operationMode,
    decision.priorityScore,
    decision.priorityLabel,
    decision.newArticles,
    decision.repairs,
    JSON.stringify(decision.signals),
    JSON.stringify(decision.reasons)
  ));
  const results = await requireDb(env).batch(statements);
  return (results || []).reduce((sum, item) => sum + Number(item?.meta?.changes || 0), 0);
}

export async function ensureAdaptiveWorkloadPlan(env, blogs = [], automation = {}, options = {}) {
  const planDate = String(options.planDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('ADAPTIVE_WORKLOAD_PLAN_DATE_INVALID');
  const effectiveByBlog = new Map((automation?.blogs || []).map((item) => [String(item.blogId), item.effective || {}]));
  const signalsByBlog = await operationalSignalsByBlog(env, planDate);
  const current = [];

  for (const blog of blogs || []) {
    const blogId = String(blog?.blogId || blog?.id || '').trim();
    if (!blogId) continue;
    current.push(deriveAdaptiveWorkloadDecision({
      blog,
      effective: effectiveByBlog.get(blogId) || automation?.global || {},
      signals: signalsByBlog.get(blogId) || {}
    }));
  }

  const refreshed = await persistCurrentDecisions(env, planDate, current);
  const stored = await listAdaptiveWorkloadDecisions(env, planDate);
  return {
    ...stored,
    inserted: refreshed,
    refreshed,
    totalPlannedWork: stored.decisions.reduce((sum, item) => sum + item.newArticles + item.repairs, 0)
  };
}

export function buildAdaptiveDailySlots(blogs = [], planDate, workload = {}) {
  const blogById = new Map((blogs || []).map((blog) => [String(blog?.blogId || blog?.id || ''), blog]));
  const slots = [];
  for (const decision of workload?.decisions || []) {
    const blog = blogById.get(String(decision.blogId));
    if (!blog) continue;
    const planned = buildDailySlots([blog], planDate, {
      newArticlesPerBlog: decision.newArticles,
      repairsPerBlog: decision.repairs
    });
    slots.push(...planned.map((slot) => ({ ...slot, priorityScore: decision.priorityScore })));
  }
  return slots;
}

export async function reconcileDailySlotsToWorkload(env, planDate, workload = {}) {
  const db = requireDb(env);
  const decisions = workload?.decisions || [];
  if (!decisions.length) return { prioritized: 0, skipped: 0 };
  let prioritized = 0;
  let skipped = 0;

  for (const decision of decisions) {
    const priority = await db.prepare(
      `UPDATE daily_plan_slots
       SET priority_score = ?, updated_at = datetime('now')
       WHERE plan_date = ? AND blog_id = ? AND priority_score <> ?`
    ).bind(decision.priorityScore, planDate, decision.blogId, decision.priorityScore).run();
    prioritized += Number(priority?.meta?.changes || 0);

    const excess = await db.prepare(
      `UPDATE daily_plan_slots
       SET status = 'skipped', last_error_code = 'WORKLOAD_RECONCILED',
           recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL,
           updated_at = datetime('now')
       WHERE plan_date = ? AND blog_id = ? AND status = 'pending' AND job_id IS NULL
         AND ((kind = 'new_article' AND slot_no > ?) OR (kind = 'repair_existing' AND slot_no > ?))`
    ).bind(planDate, decision.blogId, decision.newArticles, decision.repairs).run();
    skipped += Number(excess?.meta?.changes || 0);
  }

  return { prioritized, skipped };
}
