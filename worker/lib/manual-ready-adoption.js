import { readAutomationSettings } from './automation-settings.js';
import { dateInTimeZone } from './daily-plan.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function positiveCap(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function manualAdoptionAllowed(effective = {}) {
  return Boolean(
    effective.enabled
    && effective.autoPublishEnabled
    && effective.approvalMode === 'auto'
    && positiveCap(effective.maxPublishesPerDay) > 0
  );
}

async function listUnslottedReadyNewArticles(env) {
  const rows = await requireDb(env).prepare(
    `SELECT j.id AS job_id, j.blog_id, j.created_at
       FROM jobs j
      WHERE j.mode = 'new_article'
        AND j.status = 'ready'
        AND j.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM daily_plan_slots s WHERE s.job_id = j.id)
      ORDER BY j.created_at, j.id`
  ).all();
  return rows.results || [];
}

async function currentPlanMaxSlot(env, planDate, blogId) {
  const row = await requireDb(env).prepare(
    `SELECT MAX(slot_no) AS max_slot, COUNT(*) AS slot_count
       FROM daily_plan_slots
      WHERE plan_date = ? AND blog_id = ? AND kind = 'new_article'`
  ).bind(String(planDate), String(blogId)).first();
  return { maxSlot: Number(row?.max_slot || 0), slotCount: Number(row?.slot_count || 0) };
}

export async function adoptManualReadyArticles(env, options = {}) {
  const now = options.now || new Date();
  const planDate = options.planDate || dateInTimeZone(now, env?.OPERATIONS_TIMEZONE || 'Asia/Seoul');
  const candidates = await listUnslottedReadyNewArticles(env);
  if (candidates.length === 0) return { ok: true, planDate, considered: 0, adopted: 0, items: [] };

  const blogIds = [...new Set(candidates.map((row) => String(row.blog_id || '')).filter(Boolean))];
  const automation = options.automation || await readAutomationSettings(
    env,
    blogIds.map((blogId) => ({ blogId, name: `Blog ${blogId}` }))
  );
  const settingsByBlog = new Map((automation.blogs || []).map((row) => [String(row.blogId), row.effective || {}]));
  const byBlog = new Map();
  for (const row of candidates) {
    const blogId = String(row.blog_id || '');
    if (!byBlog.has(blogId)) byBlog.set(blogId, []);
    byBlog.get(blogId).push(row);
  }

  const items = [];
  for (const [blogId, rows] of byBlog) {
    const effective = settingsByBlog.get(blogId) || automation.global || {};
    if (!manualAdoptionAllowed(effective)) continue;
    const capacity = positiveCap(effective.maxPublishesPerDay);
    const plan = await currentPlanMaxSlot(env, planDate, blogId);

    // Wait until the ordinary daily plan exists. This prevents a manual article
    // from racing the planner for slots 1/2 at the start of the day.
    if (plan.slotCount === 0) continue;
    let nextSlot = plan.maxSlot + 1;

    for (const row of rows) {
      if (nextSlot > capacity) break;
      const inserted = await requireDb(env).prepare(
        `INSERT OR IGNORE INTO daily_plan_slots
          (plan_date, blog_id, blog_name, kind, slot_no, status, job_id, created_at, updated_at)
         VALUES (?, ?, NULL, 'new_article', ?, 'resolved', ?, datetime('now'), datetime('now'))`
      ).bind(String(planDate), blogId, nextSlot, Number(row.job_id)).run();
      if (Number(inserted?.meta?.changes || 0) === 1) {
        items.push({ jobId: Number(row.job_id), blogId, slotNo: nextSlot });
        nextSlot += 1;
      }
    }
  }

  return { ok: true, planDate, considered: candidates.length, adopted: items.length, items };
}
