import app from './mcp-entry.js';
import {
  augmentHealthResponse,
  mutationBlocked,
  pausedMutationResponse,
  systemPaused
} from './lib/maintenance-mode.js';

export default {
  async fetch(request, env, ctx) {
    const paused = systemPaused(env);
    if (mutationBlocked(request, env)) return pausedMutationResponse();

    const url = new URL(request.url);
    const response = await app.fetch(request, env, ctx);
    if (url.pathname === '/health') return augmentHealthResponse(response, paused);
    return response;
  },

  async scheduled(event, env, ctx) {
    if (systemPaused(env)) {
      console.log('SYSTEM_PAUSED_SCHEDULE_SKIPPED');
      return;
    }
    return app.scheduled(event, env, ctx);
  }
};
