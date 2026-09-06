const ACTIVE_JOB_STATES = new Set([
  'queued',
  'writing',
  'critic_review',
  'repairing',
  'final_critic',
  'ready',
  'updating_existing',
  'publishing_new'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function number(value) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function queueSummary(rows = []) {
  const byStatus = {};
  for (const row of rows) {
    const status = String(row?.status || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const active = Object.entries(byStatus).reduce((sum, [status, count]) => sum + (ACTIVE_JOB_STATES.has(status) ? count : 0), 0);
  const attention = number(byStatus.needs_review) + number(byStatus.failed);
  return { total: rows.length, active, attention, byStatus };
}

function slotSummary(slots = []) {
  return {
    total: slots.length,
    pending: slots.filter((slot) => slot.status === 'pending').length,
    resolved: slots.filter((slot) => slot.status === 'resolved').length,
    skipped: slots.filter((slot) => slot.status === 'skipped').length,
    newArticles: slots.filter((slot) => slot.kind === 'new_article').length,
    repairs: slots.filter((slot) => slot.kind === 'repair_existing').length
  };
}

export function classifyBlogDiagnostic({ blog = {}, effective = {}, jobs = [], slots = [] } = {}) {
  const blogId = String(blog.blogId || blog.id || '').trim();
  if (!blogId) throw new Error('DIAGNOSTIC_BLOG_ID_REQUIRED');
  const queue = queueSummary(jobs);
  const today = slotSummary(slots);
  const postsTotal = number(blog.postsTotal);
  const enabled = effective.enabled !== false;
  const operationMode = String(effective.operationMode || 'validation');
  const reasons = [];
  let status = 'healthy';
  let severity = 'healthy';

  if (!enabled) {
    status = 'disabled';
    severity = 'paused';
    reasons.push('AUTOMATION_DISABLED');
  } else if (queue.attention > 0) {
    status = 'attention';
    severity = 'attention';
    if (number(queue.byStatus.failed) > 0) reasons.push('FAILED_JOBS_PRESENT');
    if (number(queue.byStatus.needs_review) > 0) reasons.push('REVIEW_JOBS_PRESENT');
  } else if (queue.active > 0) {
    status = 'working';
    severity = 'active';
    reasons.push('ACTIVE_JOBS_PRESENT');
  } else if (postsTotal <= 0) {
    status = 'empty';
    severity = 'new';
    reasons.push('NO_LIVE_POSTS');
  } else {
    reasons.push('NO_BLOCKING_OPERATIONAL_ISSUES');
  }

  if (today.pending > 0) reasons.push('TODAY_SLOTS_PENDING');

  return {
    blogId,
    name: String(blog.name || blog.blogName || `Blog ${blogId}`),
    url: blog.url || null,
    language: blog.language || null,
    postsTotal,
    blogUpdatedAt: blog.updated || null,
    enabled,
    operationMode,
    status,
    severity,
    queue,
    today,
    reasons
  };
}

export function summarizeDiagnostics(diagnostics = []) {
  const summary = { total: diagnostics.length, healthy: 0, active: 0, attention: 0, paused: 0, new: 0 };
  for (const item of diagnostics) {
    if (Object.prototype.hasOwnProperty.call(summary, item.severity)) summary[item.severity] += 1;
  }
  return summary;
}

async function openJobs(env) {
  const result = await requireDb(env).prepare(
    `SELECT id, mode, blog_id, status, updated_at
     FROM jobs
     WHERE archived_at IS NULL
       AND status <> 'completed'
     ORDER BY id DESC`
  ).all();
  return result.results || [];
}

async function upsertDiagnostic(env, planDate, diagnostic) {
  await requireDb(env).prepare(
    `INSERT INTO daily_blog_diagnostics(plan_date, blog_id, status, severity, diagnosis_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(plan_date, blog_id) DO UPDATE SET
       status = excluded.status,
       severity = excluded.severity,
       diagnosis_json = excluded.diagnosis_json,
       updated_at = datetime('now')`
  ).bind(planDate, diagnostic.blogId, diagnostic.status, diagnostic.severity, JSON.stringify(diagnostic)).run();
}

export async function diagnoseBlogs(env, blogs = [], options = {}) {
  const planDate = String(options.planDate || '').trim();
  if (!planDate) throw new Error('DIAGNOSTIC_PLAN_DATE_REQUIRED');
  const automation = options.automation || { blogs: [] };
  const slots = Array.isArray(options.slots) ? options.slots : [];
  const jobs = await openJobs(env);
  const settingsByBlog = new Map((automation.blogs || []).map((item) => [String(item.blogId), item.effective || {}]));
  const diagnostics = [];

  for (const blog of blogs || []) {
    const blogId = String(blog?.blogId || blog?.id || '').trim();
    const diagnostic = classifyBlogDiagnostic({
      blog,
      effective: settingsByBlog.get(blogId) || automation.global || {},
      jobs: jobs.filter((job) => String(job.blog_id || '') === blogId),
      slots: slots.filter((slot) => String(slot.blog_id || '') === blogId)
    });
    await upsertDiagnostic(env, planDate, diagnostic);
    diagnostics.push(diagnostic);
  }

  return { planDate, diagnostics, summary: summarizeDiagnostics(diagnostics) };
}

export async function listDailyDiagnostics(env, planDate) {
  const date = String(planDate || '').trim();
  if (!date) throw new Error('DIAGNOSTIC_PLAN_DATE_REQUIRED');
  const result = await requireDb(env).prepare(
    `SELECT blog_id, diagnosis_json, updated_at
     FROM daily_blog_diagnostics
     WHERE plan_date = ?
     ORDER BY blog_id`
  ).bind(date).all();
  const diagnostics = (result.results || []).map((row) => {
    try {
      return { ...JSON.parse(String(row.diagnosis_json || '{}')), diagnosticUpdatedAt: row.updated_at || null };
    } catch {
      throw new Error('DAILY_DIAGNOSTIC_JSON_INVALID');
    }
  });
  return { planDate: date, diagnostics, count: diagnostics.length, summary: summarizeDiagnostics(diagnostics) };
}
