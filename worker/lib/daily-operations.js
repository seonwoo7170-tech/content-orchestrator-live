import { dateInTimeZone } from './daily-plan.js';
import { listDailySlots, persistDailySlots } from './daily-plan-store.js';
import { readAutomationSettings } from './automation-settings.js';
import { diagnoseBlogs } from './daily-diagnostics.js';
import {
  buildAdaptiveDailySlots,
  ensureAdaptiveWorkloadPlan,
  reconcileDailySlotsToWorkload
} from './adaptive-workload.js';

export function operationsPlanDate(env, now = new Date()) {
  return dateInTimeZone(now, env?.OPERATIONS_TIMEZONE || 'Asia/Seoul');
}

export function operationsDailyPolicy(env) {
  return {
    newArticlesPerBlog: Number(env?.DAILY_NEW_PER_BLOG ?? 1),
    repairsPerBlog: Number(env?.DAILY_REPAIR_PER_BLOG ?? 1)
  };
}

export function configuredWorkTarget(automation = {}) {
  return (automation?.blogs || []).reduce((sum, item) => {
    const effective = item?.effective || {};
    if (effective.enabled === false) return sum;
    const newArticles = effective.newArticlesEnabled === false
      ? 0
      : Math.max(0, Number(effective.newArticlesPerDay || 0));
    const repairs = effective.repairsEnabled === false
      ? 0
      : Math.max(0, Number(effective.repairsPerDay || 0));
    return sum + newArticles + repairs;
  }, 0);
}

export async function ensureDailyPlan(env, blogs, options = {}) {
  const now = options.now || new Date();
  const planDate = operationsPlanDate(env, now);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const workload = await ensureAdaptiveWorkloadPlan(env, blogs, automation, { planDate });
  const slots = buildAdaptiveDailySlots(blogs, planDate, workload);
  const persistence = await persistDailySlots(env, slots);
  const reconciliation = await reconcileDailySlotsToWorkload(env, planDate, workload);
  const stored = await listDailySlots(env, planDate);
  const diagnostic = await diagnoseBlogs(env, blogs, { planDate, automation, slots: stored });
  const configuredTargetTotal = configuredWorkTarget(automation);
  const plannedWorkTotal = Number(workload.totalPlannedWork || 0);
  const planHealth = configuredTargetTotal <= 0
    ? 'idle_configured'
    : plannedWorkTotal <= 0
      ? 'attention_zero_work'
      : 'healthy';

  if (planHealth === 'attention_zero_work') {
    console.error('AUTOMATION_ZERO_WORK_ANOMALY', JSON.stringify({
      planDate,
      blogCount: blogs.length,
      configuredTargetTotal,
      plannedWorkTotal
    }));
  }

  return {
    ok: true,
    planDate,
    blogCount: blogs.length,
    policySource: 'user-target-workload-v2',
    workload,
    configuredTargetTotal,
    plannedWorkTotal,
    planHealth,
    requestedSlots: slots.length,
    insertedSlots: persistence.inserted,
    reactivatedSlots: persistence.reactivated || 0,
    skippedExcessSlots: reconciliation.skipped,
    prioritizedSlots: reconciliation.prioritized,
    slots: stored,
    diagnostics: diagnostic.diagnostics,
    diagnosticSummary: diagnostic.summary
  };
}
