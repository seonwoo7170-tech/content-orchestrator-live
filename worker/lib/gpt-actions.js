import { handleMcpRequest } from './mcp-server.js';

const ACTION_BASE_URL = 'https://content-orchestrator.smileseon.workers.dev';

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extraHeaders
    }
  });
}

function constantTimeEqual(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

function actionAuthorized(request, env) {
  const header = String(request.headers.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expected = String(env?.GPT_ACTION_API_KEY || env?.MCP_API_KEY || env?.ADMIN_API_KEY || '');
  return Boolean(expected) && constantTimeEqual(match[1], expected);
}

async function invokeMcpTool(name, args, downstream, request, env, ctx) {
  const internalRequest = new Request(new URL('/mcp', request.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(env?.ADMIN_API_KEY || '')}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `gpt-action:${name}`,
      method: 'tools/call',
      params: { name, arguments: args || {} }
    })
  });
  const response = await handleMcpRequest(internalRequest, env, ctx, downstream);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || payload?.error || `MCP_HTTP_${response.status}`), { status: response.status });
  if (payload?.error) throw Object.assign(new Error(payload.error.message || 'MCP_RPC_ERROR'), { status: 400 });
  if (payload?.result?.isError) {
    const detail = payload.result.structuredContent || {};
    throw Object.assign(new Error(detail.error || 'ACTION_FAILED'), { status: 409, detail });
  }
  return payload?.result?.structuredContent ?? {};
}

const genericResponse = {
  description: 'Smileseon operation result',
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
};

const bearerSecurity = [{ bearerAuth: [] }];
const consequential = { 'x-openai-isConsequential': true };
const nonConsequential = { 'x-openai-isConsequential': false };

export function buildGptActionsOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Smileseon Blog Operations',
      version: '1.0.0',
      description: 'Private operations API for the owner of Smileseon. Read current work first. Mutations always use the existing Smileseon safety pipeline. Jobs 36-42 are protected and must never be changed.'
    },
    servers: [{ url: ACTION_BASE_URL }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'SmileseonActionKey' }
      }
    },
    paths: {
      '/actions/blogs': {
        get: { operationId: 'listBlogs', summary: 'List connected Blogger blogs', security: bearerSecurity, ...nonConsequential, responses: { '200': genericResponse } }
      },
      '/actions/jobs': {
        get: {
          operationId: 'listJobs', summary: 'List current Work-tab jobs', security: bearerSecurity, ...nonConsequential,
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued','writing','critic_review','repairing','final_critic','ready','updating_existing','publishing_new','completed','needs_review','failed'] } }
          ],
          responses: { '200': genericResponse }
        }
      },
      '/actions/jobs/{jobId}': {
        get: {
          operationId: 'getJob', summary: 'Read one job including its stored result', security: bearerSecurity, ...nonConsequential,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: { '200': genericResponse }
        }
      },
      '/actions/operations/today': {
        get: { operationId: 'getTodayOperations', summary: 'Read today operation plan and diagnostics', security: bearerSecurity, ...nonConsequential, responses: { '200': genericResponse } }
      },
      '/actions/operations/recovery': {
        get: { operationId: 'getRecoveryStatus', summary: 'Read retry and held recovery status', security: bearerSecurity, ...nonConsequential, responses: { '200': genericResponse } }
      },
      '/actions/publications/today': {
        get: { operationId: 'getTodayPublications', summary: 'Read today publication and Blogger verification states', security: bearerSecurity, ...nonConsequential, responses: { '200': genericResponse } }
      },
      '/actions/jobs/{jobId}/retry': {
        post: {
          operationId: 'retryJob', summary: 'Reset one failed or needs-review job for safe retry', security: bearerSecurity, ...consequential,
          description: 'Never use for jobs 36-42. This only resets through the existing Smileseon recovery rules.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: { '200': genericResponse }
        }
      },
      '/actions/jobs/{jobId}/run': {
        post: {
          operationId: 'runJob', summary: 'Run one queued job through the normal pipeline', security: bearerSecurity, ...consequential,
          description: 'Never use for jobs 36-42. Writer, Critic, Repair, image and Blogger safeguards remain active.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
          responses: { '200': genericResponse }
        }
      },
      '/actions/work-tick': {
        post: {
          operationId: 'runWorkTick', summary: 'Run a bounded amount of due planned work', security: bearerSecurity, ...consequential,
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { maxItems: { type: 'integer', minimum: 1, maximum: 10, default: 1 } } } } } },
          responses: { '200': genericResponse }
        }
      },
      '/actions/publish-tick': {
        post: {
          operationId: 'runPublishTick', summary: 'Process ready publications through safe Blogger checks', security: bearerSecurity, ...consequential,
          description: 'Refuses the whole call if any protected job 36-42 is unexpectedly ready. Never bypasses duplicate-write or read-back verification.',
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { skipImages: { type: 'boolean', default: false } } } } } },
          responses: { '200': genericResponse }
        }
      },
      '/actions/jobs/new': {
        post: {
          operationId: 'queueNewArticle', summary: 'Queue a new article job', security: bearerSecurity, ...consequential,
          description: 'Queues work only; it does not directly write to Blogger.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['blogId','topic'], properties: { blogId: { type: 'string', minLength: 1 }, topic: { type: 'string', minLength: 2 }, language: { type: 'string', enum: ['auto','ko','en'], default: 'auto' } } } } } },
          responses: { '200': genericResponse }
        }
      },
      '/actions/jobs/repair-existing': {
        post: {
          operationId: 'queueRepairExisting', summary: 'Queue a full rewrite of an existing Blogger post', security: bearerSecurity, ...consequential,
          description: 'Preserves the original Blogger Post ID and URL. If the same post already has a repair job, the existing job is reused.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['blogId','bloggerPostId'], properties: { blogId: { type: 'string', minLength: 1 }, bloggerPostId: { type: 'string', minLength: 1 }, targetUrl: { type: 'string' }, instructions: { type: 'string', maxLength: 2000 } } } } } },
          responses: { '200': genericResponse }
        }
      }
    }
  };
}

function parseJsonBody(request) {
  if (!['POST','PUT','PATCH'].includes(request.method)) return Promise.resolve({});
  return request.json().catch(() => ({}));
}

function actionRoute(url, method) {
  const path = url.pathname;
  if (method === 'GET' && path === '/actions/blogs') return ['smileseon_list_blogs', {}];
  if (method === 'GET' && path === '/actions/jobs') return ['smileseon_list_jobs', { limit: url.searchParams.get('limit') || undefined, status: url.searchParams.get('status') || undefined }];
  if (method === 'GET' && path === '/actions/operations/today') return ['smileseon_get_today', {}];
  if (method === 'GET' && path === '/actions/operations/recovery') return ['smileseon_get_recovery', {}];
  if (method === 'GET' && path === '/actions/publications/today') return ['smileseon_get_publications_today', {}];

  let match = path.match(/^\/actions\/jobs\/(\d+)$/);
  if (method === 'GET' && match) return ['smileseon_get_job', { jobId: Number(match[1]) }];
  match = path.match(/^\/actions\/jobs\/(\d+)\/retry$/);
  if (method === 'POST' && match) return ['smileseon_retry_job', { jobId: Number(match[1]) }];
  match = path.match(/^\/actions\/jobs\/(\d+)\/run$/);
  if (method === 'POST' && match) return ['smileseon_run_job', { jobId: Number(match[1]) }];
  return null;
}

export async function handleGptActionRequest(request, env, ctx, downstream) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept'
    } });
  }
  if (request.method === 'GET' && url.pathname === '/actions/openapi.json') {
    return jsonResponse(buildGptActionsOpenApi(), 200, { 'cache-control': 'public, max-age=300' });
  }
  if (!url.pathname.startsWith('/actions/')) return null;
  if (!actionAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401, { 'www-authenticate': 'Bearer realm="Smileseon GPT Actions"' });
  }

  try {
    const simple = actionRoute(url, request.method);
    if (simple) return jsonResponse(await invokeMcpTool(simple[0], simple[1], downstream, request, env, ctx));

    const body = await parseJsonBody(request);
    if (request.method === 'POST' && url.pathname === '/actions/work-tick') {
      return jsonResponse(await invokeMcpTool('smileseon_work_tick', { maxItems: body.maxItems }, downstream, request, env, ctx));
    }
    if (request.method === 'POST' && url.pathname === '/actions/publish-tick') {
      return jsonResponse(await invokeMcpTool('smileseon_publish_tick', { skipImages: Boolean(body.skipImages) }, downstream, request, env, ctx));
    }
    if (request.method === 'POST' && url.pathname === '/actions/jobs/new') {
      return jsonResponse(await invokeMcpTool('smileseon_queue_new_article', body, downstream, request, env, ctx));
    }
    if (request.method === 'POST' && url.pathname === '/actions/jobs/repair-existing') {
      return jsonResponse(await invokeMcpTool('smileseon_queue_repair_existing', body, downstream, request, env, ctx));
    }
    return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error?.message || 'ACTION_FAILED'), ...(error?.detail ? { detail: error.detail } : {}) }, Number(error?.status) || 500);
  }
}
