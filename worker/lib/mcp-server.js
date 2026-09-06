import { requireAdmin } from './admin-auth.js';

export const MCP_PROTOCOL_MODERN = '2026-07-28';
export const MCP_PROTOCOL_LEGACY = '2025-11-25';
export const MCP_SERVER_INFO = Object.freeze({ name: 'smileseon', title: 'Smileseon Blog Operations', version: '1.0.0' });
export const PROTECTED_JOB_IDS = Object.freeze([36, 37, 38, 39, 40, 41, 42]);

const PROTECTED_JOB_SET = new Set(PROTECTED_JOB_IDS);
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const MODERN_PROTOCOL_META_KEY = 'io.modelcontextprotocol/protocolVersion';

const JOB_STATUSES = [
  'queued', 'writing', 'critic_review', 'repairing', 'final_critic', 'ready',
  'updating_existing', 'publishing_new', 'completed', 'needs_review', 'failed'
];

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

export const MCP_TOOLS = Object.freeze([
  {
    name: 'smileseon_list_blogs',
    title: 'List Smileseon blogs',
    description: 'List Blogger blogs currently connected to Smileseon.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_list_jobs',
    title: 'List Work-tab jobs',
    description: 'List current non-archived Work-tab jobs. Use this before changing or retrying any job.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      status: { type: 'string', enum: JOB_STATUSES }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_get_job',
    title: 'Get one job',
    description: 'Read the full stored state and result of one Smileseon job.',
    inputSchema: objectSchema({ jobId: { type: 'integer', minimum: 1 } }, ['jobId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_get_today',
    title: 'Get today operations',
    description: 'Read today’s operation plan, slots, diagnostics, and adaptive workload.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_get_recovery',
    title: 'Get recovery status',
    description: 'Read retry-wait and held recovery status without changing jobs.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_get_publications_today',
    title: 'Get publication status',
    description: 'Read today’s Blogger publication state, including scheduled, verification, published, and updated states.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'smileseon_retry_job',
    title: 'Reset a failed job for retry',
    description: 'Safely reset a failed or needs-review job to queued. It preserves continuation state when required and refuses ambiguous Blogger writes. Jobs 36–42 are permanently protected from MCP mutation.',
    inputSchema: objectSchema({ jobId: { type: 'integer', minimum: 1 } }, ['jobId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'smileseon_run_job',
    title: 'Run one queued job',
    description: 'Start one queued job through the existing Smileseon pipeline. The execution is asynchronous and keeps all Writer/Critic/Repair/Blogger safeguards. Jobs 36–42 are protected.',
    inputSchema: objectSchema({ jobId: { type: 'integer', minimum: 1 } }, ['jobId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'smileseon_work_tick',
    title: 'Run planned work',
    description: 'Run a bounded amount of due daily-plan work through the normal automatic work pipeline.',
    inputSchema: objectSchema({ maxItems: { type: 'integer', minimum: 1, maximum: 10, default: 1 } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'smileseon_publish_tick',
    title: 'Process ready publications',
    description: 'Run the existing safe publication pipeline for ready work. This never bypasses duplicate checks, Blogger write gates, or read-back verification. If a protected job 36–42 is unexpectedly ready, the MCP call refuses the whole tick.',
    inputSchema: objectSchema({ skipImages: { type: 'boolean', default: false } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'smileseon_queue_new_article',
    title: 'Queue a new article',
    description: 'Create a new Smileseon article job. This only queues work; it does not directly write to Blogger.',
    inputSchema: objectSchema({
      blogId: { type: 'string', minLength: 1 },
      topic: { type: 'string', minLength: 2 },
      language: { type: 'string', enum: ['auto', 'ko', 'en'], default: 'auto' }
    }, ['blogId', 'topic']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'smileseon_queue_repair_existing',
    title: 'Queue an existing-post rewrite',
    description: 'Queue an existing Blogger post for Smileseon’s current full-rewrite repair pipeline while preserving the original Blogger Post ID and URL. If the same post already has active repair work, the existing job is returned instead of creating a duplicate.',
    inputSchema: objectSchema({
      blogId: { type: 'string', minLength: 1 },
      bloggerPostId: { type: 'string', minLength: 1 },
      targetUrl: { type: 'string' },
      instructions: { type: 'string', maxLength: 2000 }
    }, ['blogId', 'bloggerPostId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]);

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

function rpcError(id, code, message, data = undefined, status = 200) {
  return jsonResponse({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  }, status);
}

function modernRequest(request, body) {
  return request.headers.get('MCP-Protocol-Version') === MCP_PROTOCOL_MODERN
    || body?.params?._meta?.[MODERN_PROTOCOL_META_KEY] === MCP_PROTOCOL_MODERN;
}

function stampResult(result, modern) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: {
      ...(result?._meta || {}),
      [SERVER_INFO_META_KEY]: MCP_SERVER_INFO
    }
  };
}

function rpcResult(id, result, modern = false, status = 200) {
  return jsonResponse({ jsonrpc: '2.0', id, result: stampResult(result, modern) }, status);
}

function constantTimeEqual(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

async function authorized(request, env) {
  if (await requireAdmin(request, env)) return true;
  const header = String(request.headers.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expected = String(env?.MCP_API_KEY || env?.ADMIN_API_KEY || '');
  return Boolean(expected) && constantTimeEqual(match[1], expected);
}

function validateModernHeaders(request, body) {
  const version = request.headers.get('MCP-Protocol-Version');
  if (version && version !== MCP_PROTOCOL_MODERN) return `UNSUPPORTED_PROTOCOL_VERSION:${version}`;
  if (version !== MCP_PROTOCOL_MODERN) return null;
  const method = request.headers.get('Mcp-Method');
  if (!method || method !== body?.method) return 'MCP_METHOD_HEADER_MISMATCH';
  if (body?.method === 'tools/call') {
    const name = request.headers.get('Mcp-Name');
    if (!name || name !== body?.params?.name) return 'MCP_NAME_HEADER_MISMATCH';
  }
  return null;
}

function toolFailure(message, data = null) {
  const payload = { ok: false, error: String(message || 'TOOL_FAILED'), ...(data ? { data } : {}) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function toolSuccess(data) {
  const payload = data && typeof data === 'object' ? data : { value: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function positiveInteger(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name}_INVALID`);
  return number;
}

function requiredString(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new Error(code);
  return text;
}

function assertMutableJob(jobId) {
  const id = positiveInteger(jobId, NaN, 1, Number.MAX_SAFE_INTEGER, 'JOB_ID');
  if (PROTECTED_JOB_SET.has(id)) throw new Error(`MCP_PROTECTED_JOB_${id}`);
  return id;
}

async function internalApi(downstream, request, env, ctx, path, options = {}) {
  const url = new URL(path, request.url);
  const headers = new Headers(options.headers || {});
  headers.set('x-admin-api-key', String(env.ADMIN_API_KEY || ''));
  headers.set('accept', 'application/json');
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await downstream.fetch(new Request(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }), env, ctx);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(data?.error || `HTTP_${response.status}`));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function protectedReadyJobExists(downstream, request, env, ctx) {
  const jobs = await internalApi(downstream, request, env, ctx, '/api/jobs?limit=100');
  return (jobs.jobs || []).find((row) => PROTECTED_JOB_SET.has(Number(row.id)) && ['ready', 'publishing_new', 'updating_existing'].includes(String(row.status || ''))) || null;
}

async function callTool(name, args, downstream, request, env, ctx) {
  switch (name) {
    case 'smileseon_list_blogs':
      return internalApi(downstream, request, env, ctx, '/api/blogs');
    case 'smileseon_list_jobs': { 
      const limit = positiveInteger(args?.limit, 30, 1, 100, 'LIMIT');
      const status = args?.status ? requiredString(args.status, 'STATUS_REQUIRED') : '';
      const query = new URLSearchParams({ limit: String(limit) });
      if (status) query.set('status', status);
      return internalApi(downstream, request, env, ctx, `/api/jobs?${query}`);
    }
    case 'smileseon_get_job': {
      const jobId = positiveInteger(args?.jobId, NaN, 1, Number.MAX_SAFE_INTEGER, 'JOB_ID');
      return internalApi(downstream, request, env, ctx, `/api/jobs/${jobId}`);
    }
    case 'smileseon_get_today':
      return internalApi(downstream, request, env, ctx, '/api/operations/today');
    case 'smileseon_get_recovery':
      return internalApi(downstream, request, env, ctx, '/api/operations/recovery');
    case 'smileseon_get_publications_today':
      return internalApi(downstream, request, env, ctx, '/api/operations/publications/today');
    case 'smileseon_retry_job': {
      const jobId = assertMutableJob(args?.jobId);
      return internalApi(downstream, request, env, ctx, `/api/jobs/${jobId}/retry`, { method: 'POST', body: {} });
    }
    case 'smileseon_run_job': {
      const jobId = assertMutableJob(args?.jobId);
      return internalApi(downstream, request, env, ctx, `/api/jobs/${jobId}/run`, { method: 'POST', body: {} });
    }
    case 'smileseon_work_tick': {
      const maxItems = positiveInteger(args?.maxItems, 1, 1, 10, 'MAX_ITEMS');
      return internalApi(downstream, request, env, ctx, `/api/operations/work-tick?maxItems=${maxItems}`, { method: 'POST', body: {} });
    }
    case 'smileseon_publish_tick': {
      const protectedJob = await protectedReadyJobExists(downstream, request, env, ctx);
      if (protectedJob) throw new Error(`MCP_PROTECTED_JOB_${protectedJob.id}_BLOCKS_PUBLISH_TICK`);
      const skipImages = Boolean(args?.skipImages);
      return internalApi(downstream, request, env, ctx, `/api/operations/publish-tick${skipImages ? '?images=false' : ''}`, { method: 'POST', body: {} });
    }
    case 'smileseon_queue_new_article': {
      const blogId = requiredString(args?.blogId, 'BLOG_ID_REQUIRED');
      const topic = requiredString(args?.topic, 'TOPIC_REQUIRED');
      const language = String(args?.language || 'auto').trim().toLowerCase();
      if (!['auto', 'ko', 'en'].includes(language)) throw new Error('LANGUAGE_INVALID');
      return internalApi(downstream, request, env, ctx, '/api/jobs/new', { method: 'POST', body: { blogId, topic, language } });
    }
    case 'smileseon_queue_repair_existing': {
      const blogId = requiredString(args?.blogId, 'BLOG_ID_REQUIRED');
      const bloggerPostId = requiredString(args?.bloggerPostId, 'BLOGGER_POST_ID_REQUIRED');
      const current = await internalApi(downstream, request, env, ctx, '/api/jobs?limit=100');
      const duplicate = (current.jobs || []).find((row) =>
        String(row.mode || '') === 'repair_existing'
        && String(row.blog_id || '') === blogId
        && String(row.blogger_post_id || '') === bloggerPostId
      );
      if (duplicate) return { ok: true, reusedExisting: true, jobId: Number(duplicate.id), job: duplicate };
      return internalApi(downstream, request, env, ctx, '/api/jobs/repair-existing', {
        method: 'POST',
        body: {
          blogId,
          bloggerPostId,
          targetUrl: args?.targetUrl ? String(args.targetUrl) : undefined,
          instructions: args?.instructions ? String(args.instructions) : undefined
        }
      });
    }
    default:
      throw Object.assign(new Error(`MCP_TOOL_NOT_FOUND:${name}`), { rpcCode: -32602 });
  }
}

function discoverResult() {
  return {
    supportedVersions: [MCP_PROTOCOL_MODERN, MCP_PROTOCOL_LEGACY],
    capabilities: { tools: { listChanged: false } },
    instructions: 'Use read tools first. Never mutate protected jobs 36–42. Retry only failed/needs-review work, then run queued work. Publication tools always use Smileseon safety gates.',
    ttlMs: 60000,
    cacheScope: 'private'
  };
}

export async function handleMcpRequest(request, env, ctx, downstream) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name'
      }
    });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST, OPTIONS' });
  if (!await authorized(request, env)) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401, { 'www-authenticate': 'Bearer realm="Smileseon MCP"' });
  }

  let body;
  try { body = await request.json(); } catch { return rpcError(null, -32700, 'Parse error', undefined, 400); }
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body?.id, -32600, 'Invalid Request', undefined, 400);

  const modern = modernRequest(request, body);
  const headerError = validateModernHeaders(request, body);
  if (headerError) return rpcError(body.id, -32020, headerError, undefined, 400);

  if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
  if (body.method === 'ping') return rpcResult(body.id, {}, modern);
  if (body.method === 'server/discover') return rpcResult(body.id, discoverResult(), true);
  if (body.method === 'initialize') {
    const requested = String(body?.params?.protocolVersion || MCP_PROTOCOL_LEGACY);
    const selected = requested === MCP_PROTOCOL_LEGACY ? MCP_PROTOCOL_LEGACY : MCP_PROTOCOL_LEGACY;
    return rpcResult(body.id, {
      protocolVersion: selected,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: discoverResult().instructions
    }, false);
  }
  if (body.method === 'tools/list') {
    return rpcResult(body.id, {
      tools: MCP_TOOLS,
      ...(modern ? { ttlMs: 60000, cacheScope: 'private' } : {})
    }, modern);
  }
  if (body.method === 'tools/call') {
    const name = String(body?.params?.name || '').trim();
    if (!name) return rpcError(body.id, -32602, 'Tool name required');
    try {
      const result = await callTool(name, body?.params?.arguments || {}, downstream, request, env, ctx);
      return rpcResult(body.id, toolSuccess(result), modern);
    } catch (error) {
      if (error?.rpcCode) return rpcError(body.id, error.rpcCode, error.message);
      return rpcResult(body.id, toolFailure(error?.message || 'TOOL_FAILED', error?.data || null), modern);
    }
  }

  return rpcError(body.id, -32601, 'Method not found');
}
