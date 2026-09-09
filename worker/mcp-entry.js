import app from './phase6-trends-entry.js';
import { runScheduledAutomaticWork, runScheduledJobRecovery } from './entry.js';
import { loadConnectedBlogs } from './lib/connected-blogs.js';
import { readAutomationSettings } from './lib/automation-settings.js';
import { handleMcpRequest } from './lib/mcp-server.js';
import { handleGptActionRequest } from './lib/gpt-actions.js';
import { reconcilePendingPublicationReadbacks } from './lib/publication-readback-recovery.js';
import { runScheduledImageCompletion } from './lib/image-completion.js';
import { releaseSafeRepairHolds } from './lib/repair-hold-recovery.js';
import { acquireRuntimeLock, releaseRuntimeLock, renewRuntimeLock } from './lib/runtime-lock.js';

const WATCHDOG_CRON = '*/3 * * * *';
const LEGACY_MAINTENANCE_CRON = '*/5 * * * *';
const ACTIVE_AI_STATUSES = ['writing', 'critic_review', 'repairing', 'final_critic'];
const IMAGE_LANE_LOCK_KEY = 'serial-image-kie';

function scheduledTime(event) {
  const value = Number(event?.scheduledTime || 0);
  return Number.isFinite(value) && value > 0 ? new Date(value) : new Date();
}

function safeScheduledError(error) {
  return String(error?.message || error?.name || 'SCHEDULED_TASK_FAILED')
    .replace(/[^A-Za-z0-9_:-]/g, '_')
    .slice(0, 96);
}

function positiveBounded(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyWork(reason = null) {
  return {
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: reason ? 1 : 0,
    reason
  };
}

function emptyRecovery(errorCode = null) {
  return {
    attempted: 0,
    completed: 0,
    retryWait: 0,
    held: 0,
    skipped: 0,
    errorCode
  };
}

function emptyPublicationReadback(errorCode = null) {
  return {
    checked: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    errorCode
  };
}

function emptyRepairHoldRecovery(errorCode = null) {
  return {
    checked: 0,
    releasedReady: 0,
    releasedRetry: 0,
    keptHeld: 0,
    errorCode
  };
}

function emptyImageWork(errorCode = null) {
  return {
    ok: errorCode === null,
    enabled: true,
    attempted: 0,
    completed: 0,
    items: [],
    errorCode
  };
}

function resultCodes(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  return items.flatMap((item) => [
    item?.errorCode,
    item?.recovery?.code,
    item?.recoveryRegistrationError
  ]).filter(Boolean).map((code) => String(code).toUpperCase());
}

function providerBackoffRequired(value) {
  return resultCodes(value).some((code) =>
    code === 'RESOURCE_EXHAUSTED'
    || code === 'FETCH_FAILED'
    || code === 'NETWORK_ERROR'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'API_HUB_429'
    || code.startsWith('API_HUB_50')
    || code.includes('RATE_LIMIT')
    || code.includes('ACCOUNT_LIMITED')
    || code.includes('DAILY_ALLOCATION')
    || code.includes('DAILY_QUOTA')
    || code.includes('TIMEOUT')
    || code.includes('UNAVAILABLE')
    || code.includes('UPSTREAM')
    || code.includes('PROVIDER_ERROR')
  );
}

function imageProviderBackoffRequired(value) {
  if (value?.ok === false) return true;
  const items = Array.isArray(value?.items) ? value.items : [];
  return items.some((item) => Number(item?.failed || 0) > 0 || Boolean(item?.errorCode));
}

async function activeAiJob(env) {
  if (!env?.ORCHESTRATOR_DB) return null;
  const row = await env.ORCHESTRATOR_DB.prepare(
    `SELECT id, status
       FROM jobs
      WHERE archived_at IS NULL
        AND status IN ('writing', 'critic_review', 'repairing', 'final_critic')
      ORDER BY updated_at, id
      LIMIT 1`
  ).first();
  return row ? { id: Number(row.id), status: String(row.status || '') } : null;
}

function compactRecovery(value, errorCode = null) {
  return {
    attempted: Number(value?.attempted || 0),
    completed: Number(value?.completed || 0),
    retryWait: Number(value?.retryWait || 0),
    held: Number(value?.held || 0),
    skipped: Number(value?.skipped || 0),
    errorCode: errorCode || value?.errorCode || null,
    codes: resultCodes(value)
  };
}

function compactWork(value, errorCode = null) {
  return {
    attempted: Number(value?.attempted || 0),
    completed: Number(value?.completed || 0),
    failed: Number(value?.failed || 0),
    skipped: Number(value?.skipped || 0),
    reason: value?.reason || null,
    errorCode: errorCode || value?.errorCode || null,
    codes: resultCodes(value)
  };
}

function compactImageWork(value, errorCode = null) {
  const items = Array.isArray(value?.items) ? value.items : [];
  const codes = items
    .map((item) => String(item?.errorCode || '').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 96))
    .filter(Boolean);
  return {
    attempted: Number(value?.attempted || 0),
    completed: Number(value?.completed || 0),
    failed: items.reduce((sum, item) => sum + Number(item?.failed || 0), 0),
    errorCode: errorCode || value?.errorCode || null,
    codes,
    jobIds: items.map((item) => Number(item?.jobId || 0)).filter(Boolean)
  };
}

async function runSerialAiWatchdog(env, ctx, eventNow) {
  const cooldownMs = positiveBounded(env?.SERIAL_AI_COOLDOWN_MS, 30_000, 5_000, 120_000);
  const maxItems = positiveBounded(env?.SERIAL_AI_CHAIN_MAX_ITEMS, 4, 1, 8);
  const startCutoffMs = positiveBounded(env?.SERIAL_AI_CHAIN_START_CUTOFF_MS, 420_000, 60_000, 720_000);
  const startedAt = Date.now();
  const steps = [];

  let publicationReadback = emptyPublicationReadback();
  let publicationReadbackError = null;
  try {
    publicationReadback = await reconcilePendingPublicationReadbacks(env, { limit: 2 });
  } catch (error) {
    publicationReadbackError = safeScheduledError(error);
    publicationReadback = emptyPublicationReadback(publicationReadbackError);
    console.error('PUBLICATION_READBACK_RECOVERY_FAILED', publicationReadbackError);
  }

  let repairHoldRecovery = emptyRepairHoldRecovery();
  let repairHoldRecoveryError = null;
  try {
    repairHoldRecovery = await releaseSafeRepairHolds(env, { limit: 2 });
  } catch (error) {
    repairHoldRecoveryError = safeScheduledError(error);
    repairHoldRecovery = emptyRepairHoldRecovery(repairHoldRecoveryError);
    console.error('REPAIR_HOLD_RECOVERY_FAILED', repairHoldRecoveryError);
  }

  let blogs;
  let automation;
  try {
    blogs = await loadConnectedBlogs(env);
    automation = await readAutomationSettings(env, blogs);
  } catch (error) {
    const errorCode = safeScheduledError(error);
    console.error('SERIAL_AI_CONTEXT_FAILED', errorCode);
    return {
      ok: false,
      stopReason: 'CONTEXT_FAILED',
      errorCode,
      cooldownMs,
      maxItems,
      steps,
      publicationReadback,
      publicationReadbackError,
      repairHoldRecovery,
      repairHoldRecoveryError
    };
  }

  let stopReason = 'NO_ELIGIBLE_WORK';

  for (let index = 0; index < maxItems; index += 1) {
    const active = await activeAiJob(env);
    if (active) {
      stopReason = 'ACTIVE_AI_JOB';
      steps.push({ sequence: index + 1, type: 'guard', active });
      break;
    }

    const now = index === 0 ? eventNow : new Date();
    let recovery = emptyRecovery();
    let recoveryError = null;
    try {
      recovery = await runScheduledJobRecovery(
        { ...env, JOB_RECOVERY_MAX_ITEMS: '1' },
        now,
        { blogs, automation, executionContext: ctx }
      );
    } catch (error) {
      recoveryError = safeScheduledError(error);
      recovery = emptyRecovery(recoveryError);
      console.error('SCHEDULED_RECOVERY_FAILED', recoveryError);
    }

    if (recoveryError) {
      steps.push({ sequence: index + 1, type: 'recovery', ...compactRecovery(recovery, recoveryError) });
      stopReason = 'RECOVERY_ERROR';
      break;
    }

    const recoveryPriority = Number(recovery?.attempted || 0) > 0
      || Number(recovery?.autoRescue?.retryDue || 0) > 0
      || Number(recovery?.autoRescue?.revived || 0) > 0;

    if (recoveryPriority) {
      steps.push({ sequence: index + 1, type: 'recovery', ...compactRecovery(recovery) });
      if (providerBackoffRequired(recovery)) {
        stopReason = 'PROVIDER_BACKOFF';
        break;
      }
      if (Number(recovery?.attempted || 0) === 0) {
        stopReason = 'RECOVERY_PRIORITY';
        break;
      }
    } else {
      let work = emptyWork();
      let workError = null;
      try {
        work = await runScheduledAutomaticWork(env, now, {
          maxItems: 1,
          blogs,
          automation,
          executionContext: ctx
        });
      } catch (error) {
        workError = safeScheduledError(error);
        work = { ...emptyWork(), failed: 1, errorCode: workError };
        console.error('SCHEDULED_AUTOMATIC_WORK_FAILED', workError);
      }

      steps.push({ sequence: index + 1, type: 'automaticWork', ...compactWork(work, workError) });
      if (workError) {
        stopReason = 'AUTOMATIC_WORK_ERROR';
        break;
      }
      if (Number(work?.attempted || 0) === 0) {
        stopReason = 'NO_ELIGIBLE_WORK';
        break;
      }
      if (providerBackoffRequired(work)) {
        stopReason = 'PROVIDER_BACKOFF';
        break;
      }
    }

    if (index + 1 >= maxItems) {
      stopReason = 'CHAIN_ITEM_LIMIT';
      break;
    }
    if (Date.now() - startedAt >= startCutoffMs) {
      stopReason = 'CHAIN_TIME_GUARD';
      break;
    }

    stopReason = 'COOLDOWN';
    await sleep(cooldownMs);
  }

  return {
    ok: !['CONTEXT_FAILED', 'RECOVERY_ERROR', 'AUTOMATIC_WORK_ERROR'].includes(stopReason),
    watchdogCron: WATCHDOG_CRON,
    cooldownMs,
    maxItems,
    startCutoffMs,
    stopReason,
    durationMs: Date.now() - startedAt,
    publicationReadback: {
      ok: publicationReadbackError === null && publicationReadback?.ok !== false,
      checked: Number(publicationReadback?.checked || 0),
      completed: Number(publicationReadback?.completed || 0),
      pending: Number(publicationReadback?.pending || 0),
      failed: Number(publicationReadback?.failed || 0),
      errorCode: publicationReadbackError || publicationReadback?.errorCode || null
    },
    repairHoldRecovery: {
      ok: repairHoldRecoveryError === null && repairHoldRecovery?.ok !== false,
      checked: Number(repairHoldRecovery?.checked || 0),
      releasedReady: Number(repairHoldRecovery?.releasedReady || 0),
      releasedRetry: Number(repairHoldRecovery?.releasedRetry || 0),
      keptHeld: Number(repairHoldRecovery?.keptHeld || 0),
      errorCode: repairHoldRecoveryError || repairHoldRecovery?.errorCode || null
    },
    steps
  };
}

async function runSerialImageWatchdog(env, ctx) {
  const maxItems = positiveBounded(env?.SERIAL_IMAGE_CHAIN_MAX_ITEMS, 8, 1, 8);
  const leaseTtlSeconds = positiveBounded(env?.SERIAL_IMAGE_LEASE_TTL_SECONDS, 210, 60, 900);
  const startedAt = Date.now();
  const steps = [];
  const lease = await acquireRuntimeLock(env, IMAGE_LANE_LOCK_KEY, { ttlSeconds: leaseTtlSeconds });
  if (!lease.acquired) return { ok: true, watchdogCron: WATCHDOG_CRON, providerPriority: 'puter->kie->cloudflare', cooldownMs: 0, maxItems, stopReason: 'IMAGE_LANE_BUSY', durationMs: Date.now() - startedAt, steps };
  let stopReason = 'NO_ELIGIBLE_IMAGES';
  try {
    if (!await renewRuntimeLock(env, lease, { ttlSeconds: leaseTtlSeconds })) {
      stopReason = 'IMAGE_LANE_LEASE_LOST';
    } else {
      let imageWork = emptyImageWork();
      let imageError = null;
      try {
        imageWork = await runScheduledImageCompletion(env, { maxJobs: maxItems, maxImages: 1, staleMinutes: 0, executionContext: ctx });
      } catch (error) {
        imageError = safeScheduledError(error);
        imageWork = emptyImageWork(imageError);
        console.error('SERIAL_IMAGE_WORK_FAILED', imageError);
      }
      steps.push({ sequence: 1, ...compactImageWork(imageWork, imageError) });
      if (imageError) stopReason = 'IMAGE_WORK_ERROR';
      else if (imageWork?.enabled === false) stopReason = String(imageWork?.reason || 'IMAGE_WORK_DISABLED');
      else if (Number(imageWork?.attempted || 0) === 0) stopReason = 'NO_ELIGIBLE_IMAGES';
      else if (imageProviderBackoffRequired(imageWork)) stopReason = 'IMAGE_PROVIDER_BACKOFF';
      else stopReason = 'BATCH_DISPATCHED';
    }
  } finally {
    await releaseRuntimeLock(env, lease).catch((error) => console.error('SERIAL_IMAGE_LEASE_RELEASE_FAILED', safeScheduledError(error)));
  }
  return { ok: !['IMAGE_WORK_ERROR', 'IMAGE_LANE_LEASE_LOST'].includes(stopReason), watchdogCron: WATCHDOG_CRON, providerPriority: 'puter->kie->cloudflare', cooldownMs: 0, maxItems, leaseTtlSeconds, stopReason, durationMs: Date.now() - startedAt, steps };
}

async function runLegacyMaintenance(event, env, ctx) {
  const delegatedEnv = {
    ...env,
    DAILY_WORK_EXECUTION_ENABLED: 'false',
    JOB_RECOVERY_EXECUTION_ENABLED: 'false'
  };
  try {
    await app.scheduled(event, delegatedEnv, ctx);
    console.log('LEGACY_SCHEDULED_TICK', JSON.stringify({ at: scheduledTime(event).toISOString(), ok: true }));
  } catch (error) {
    const errorCode = safeScheduledError(error);
    console.error('LEGACY_SCHEDULED_CHAIN_FAILED', errorCode);
    console.log('LEGACY_SCHEDULED_TICK', JSON.stringify({ at: scheduledTime(event).toISOString(), ok: false, errorCode }));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcpRequest(request, env, ctx, app);
    if (url.pathname.startsWith('/actions/')) return handleGptActionRequest(request, env, ctx, app);
    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (event?.cron === LEGACY_MAINTENANCE_CRON) {
      await runLegacyMaintenance(event, env, ctx);
      return;
    }
    if (event?.cron !== WATCHDOG_CRON) return;

    const [aiSummary, imageSummary] = await Promise.all([
      runSerialAiWatchdog(env, ctx, scheduledTime(event)),
      runSerialImageWatchdog(env, ctx)
    ]);
    console.log('SERIAL_AI_WATCHDOG', JSON.stringify(aiSummary));
    console.log('SERIAL_IMAGE_WATCHDOG', JSON.stringify(imageSummary));
  }
};
