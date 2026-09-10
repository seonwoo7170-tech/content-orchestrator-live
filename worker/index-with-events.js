import baseWorker from './index.js';
import { requireAdmin } from './lib/admin-auth.js';
import { listJobEvents } from './lib/job-events.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function matchJobEventsPath(pathname) {
  const match = String(pathname || '').match(/^\/api\/jobs\/(\d+)\/events$/);
  return match ? Number(match[1]) : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const jobId = matchJobEventsPath(url.pathname);
    if (request.method === 'GET' && jobId !== null) {
      if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
      try {
        const events = await listJobEvents(env, jobId, {
          afterId: url.searchParams.get('after'),
          limit: url.searchParams.get('limit')
        });
        return json({
          jobId,
          events,
          count: events.length,
          lastEventId: events.length ? Number(events[events.length - 1].id) : Number(url.searchParams.get('after') || 0)
        });
      } catch (error) {
        return json({ error: error?.message || 'JOB_EVENTS_FAILED' }, error?.status || 500);
      }
    }
    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return baseWorker.scheduled(controller, env, ctx);
  }
};
