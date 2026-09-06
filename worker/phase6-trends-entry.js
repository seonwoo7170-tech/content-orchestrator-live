import phase6Entry from './phase6-entry.js';
import { requireAdmin } from './lib/admin-auth.js';
import { loadConnectedBlogs } from './lib/connected-blogs.js';
import { readAutomationSettings } from './lib/automation-settings.js';
import { listKeywordRankings, listTrendInsights, refreshTrendKeywords } from './lib/trend-keywords.js';
import { handleHubWriterTransportDiagnostic, HUB_WRITER_TRANSPORT_DIAGNOSTIC_PATH } from './lib/hub-writer-transport-diagnostic.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function safeCode(error) {
  return String(error?.code || error?.message || 'TREND_STRATEGY_FAILED')
    .split(/[:\s]/)[0]
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .slice(0, 80) || 'TREND_STRATEGY_FAILED';
}

function timeInSeoul(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function isTrendRefreshDue(env, now = new Date()) {
  const configured = String(env?.TREND_REFRESH_TIMES || '08:35,13:35')
    .split(',').map((item) => item.trim()).filter((item) => /^\d{2}:\d{2}$/.test(item));
  return configured.includes(timeInSeoul(now));
}

async function blogContexts(env) {
  const blogs = await loadConnectedBlogs(env);
  const automation = await readAutomationSettings(env, blogs);
  return (automation?.blogs || []).map((item) => ({
    blogId: String(item.blogId || ''),
    language: item.resolvedLanguage || 'ko',
    enabled: item?.effective?.enabled !== false
  })).filter((item) => item.blogId);
}

async function refreshTrends(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await refreshTrendKeywords(env, await blogContexts(env), { now: new Date() });
  return json(result, result.ok ? 200 : 207);
}

async function trendOverview(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  return json(await listTrendInsights(env, {
    blogId: url.searchParams.get('blogId') || '',
    limit: url.searchParams.get('limit') || 80
  }));
}

async function rankings(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  return json(await listKeywordRankings(env, {
    blogId: url.searchParams.get('blogId') || '',
    limit: url.searchParams.get('limit') || 160
  }));
}

async function scheduledTrendRefresh(env, now) {
  if (!isTrendRefreshDue(env, now)) return { ok: true, checked: false, reason: 'NOT_DUE' };
  return refreshTrendKeywords(env, await blogContexts(env), { now });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === HUB_WRITER_TRANSPORT_DIAGNOSTIC_PATH) {
        return await handleHubWriterTransportDiagnostic(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/trends') {
        return await trendOverview(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/strategy/trends/refresh') {
        return await refreshTrends(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/rankings') {
        return await rankings(request, env);
      }
      return phase6Entry.fetch(request, env, ctx);
    } catch (error) {
      return json({ error: safeCode(error) }, error?.status || 500);
    }
  },

  scheduled(event, env, ctx) {
    if (event?.cron === '*/5 * * * *') {
      const now = new Date(event?.scheduledTime || Date.now());
      if (isTrendRefreshDue(env, now)) {
        ctx.waitUntil(
          scheduledTrendRefresh(env, now).catch((error) => {
            console.error('TREND_KEYWORD_REFRESH_FAILED', safeCode(error));
            return { ok: false, error: safeCode(error) };
          })
        );
      }
    }
    return phase6Entry.scheduled(event, env, ctx);
  }
};
