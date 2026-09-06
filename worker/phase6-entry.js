import phase5Entry from './phase5-entry.js';
import { requireAdmin } from './lib/admin-auth.js';
import { loadConnectedBlogs } from './lib/connected-blogs.js';
import { readAutomationSettings } from './lib/automation-settings.js';
import { runDueJobRecoveries } from './lib/job-recovery-runner.js';
import { resetStoredJobForManualRetry } from './lib/job-store.js';
import { listJobImages } from './lib/image-store.js';
import {
  ensureDefaultExternalSettings,
  ingestExternalPerformance,
  listExternalTrafficOverview,
  resolveExternalTrackingRedirect,
  runExternalDeliveryTick,
  syncExternalContentAssets,
  updateExternalChannelSetting
} from './lib/external-traffic.js';
import {
  isLikelyAutomatedRequest,
  resolveExternalTrackingDestination
} from './lib/external-tracking-redirect.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function safeCode(error) {
  return String(error?.code || error?.message || 'PHASE6_FAILED')
    .split(/[:\s]/)[0]
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .slice(0, 80) || 'PHASE6_FAILED';
}

async function requireAdminOr401(request, env) {
  return await requireAdmin(request, env);
}

function boundedInteger(value, fallback, min, max, code) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(code), { status: 400 });
  }
  return number;
}

async function recoveryTick(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const maxItems = boundedInteger(url.searchParams.get('maxItems') || 1, 1, 1, 5, 'RECOVERY_TICK_LIMIT_INVALID');
  const staleMinutes = boundedInteger(url.searchParams.get('staleMinutes') || 20, 20, 5, 1440, 'RECOVERY_STALE_MINUTES_INVALID');
  const blogs = await loadConnectedBlogs(env);
  const automation = await readAutomationSettings(env, blogs);
  const result = await runDueJobRecoveries(env, {
    now: new Date(),
    maxItems,
    staleMinutes,
    automation
  });
  return json({ ...result, maxItems, staleMinutes }, result.ok === false ? 207 : 200);
}

async function externalOverview(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const blogs = await loadConnectedBlogs(env);
  await ensureDefaultExternalSettings(env, blogs);
  return json(await listExternalTrafficOverview(env, {
    blogId: url.searchParams.get('blogId') || '',
    limit: url.searchParams.get('limit') || 50
  }));
}

async function syncExternal(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const blogs = await loadConnectedBlogs(env);
  const settings = await ensureDefaultExternalSettings(env, blogs);
  const assets = await syncExternalContentAssets(env, { limit: 120 });
  return json({ ok: true, settings, assets });
}

async function updateExternalSetting(request, env, blogId, channel) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  return json(await updateExternalChannelSetting(env, blogId, channel, body));
}

async function externalDeliveryTick(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const maxItems = Math.max(1, Math.min(3, Number(url.searchParams.get('maxItems') || 1)));
  return json(await runExternalDeliveryTick(env, { maxItems, now: new Date() }));
}

async function externalPerformance(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  return json(await ingestExternalPerformance(env, body));
}

async function retryExistingJob(request, env, jobId) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const images = await listJobImages(env, jobId).catch(() => []);
  const reset = await resetStoredJobForManualRetry(env, jobId);
  const storageKeys = reset.preserveImages
    ? []
    : [...new Set(images.map((image) => String(image.storage_key || '').trim()).filter(Boolean))];
  if (env.IMAGE_BUCKET && typeof env.IMAGE_BUCKET.delete === 'function' && storageKeys.length) {
    await Promise.allSettled(storageKeys.map((key) => env.IMAGE_BUCKET.delete(key)));
  }
  return json({ ...reset, reused: true, clearedImages: reset.preserveImages ? 0 : images.length });
}

async function trackingRedirect(request, env, code) {
  const automated = isLikelyAutomatedRequest(request);
  const result = automated
    ? await resolveExternalTrackingDestination(env, code)
    : await resolveExternalTrackingRedirect(env, code, request);
  if (!result?.location) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(null, {
    status: 302,
    headers: {
      location: result.location,
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-smileseon-tracking': automated ? 'preview-excluded' : 'counted'
    }
  });
}

async function runExternalMaintenance(env, now = new Date()) {
  const blogs = await loadConnectedBlogs(env);
  await ensureDefaultExternalSettings(env, blogs);
  const assets = await syncExternalContentAssets(env, { limit: 120 });
  const delivery = await runExternalDeliveryTick(env, { maxItems: 1, now });
  return { ok: true, assets, delivery };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      const redirect = url.pathname.match(/^\/go\/([A-Za-z0-9_-]{4,80})$/);
      if (request.method === 'GET' && redirect) return await trackingRedirect(request, env, redirect[1]);

      const retryJob = url.pathname.match(/^\/api\/jobs\/(\d+)\/retry$/);
      if (request.method === 'POST' && retryJob) {
        return await retryExistingJob(request, env, Number(retryJob[1]));
      }

      if (request.method === 'POST' && url.pathname === '/api/operations/recovery-tick') {
        return await recoveryTick(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/external/overview') {
        return await externalOverview(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/external/sync') {
        return await syncExternal(request, env);
      }
      const setting = url.pathname.match(/^\/api\/external\/settings\/([^/]+)\/([^/]+)$/);
      if (['PUT', 'POST'].includes(request.method) && setting) {
        return await updateExternalSetting(request, env, decodeURIComponent(setting[1]), decodeURIComponent(setting[2]));
      }
      if (request.method === 'POST' && url.pathname === '/api/external/delivery-tick') {
        return await externalDeliveryTick(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/external/performance') {
        return await externalPerformance(request, env);
      }
      return phase5Entry.fetch(request, env, ctx);
    } catch (error) {
      return json({ error: safeCode(error) }, error?.status || 500);
    }
  },

  scheduled(event, env, ctx) {
    if (event?.cron === '*/5 * * * *') {
      const now = new Date(event?.scheduledTime || Date.now());
      ctx.waitUntil(
        runExternalMaintenance(env, now).catch((error) => {
          console.error('EXTERNAL_TRAFFIC_TICK_FAILED', safeCode(error));
          return { ok: false, error: safeCode(error) };
        })
      );
    }
    return phase5Entry.scheduled(event, env, ctx);
  }
};
