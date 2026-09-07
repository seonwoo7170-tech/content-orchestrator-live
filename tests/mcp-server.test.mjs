import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleMcpRequest,
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  MCP_TOOLS,
  PROTECTED_JOB_IDS
} from '../worker/lib/mcp-server.js';

const env = { ADMIN_API_KEY: 'admin-secret' };
const ctx = { waitUntil() {} };

function request(body, options = {}) {
  const headers = new Headers({
    authorization: 'Bearer admin-secret',
    'content-type': 'application/json',
    ...(options.headers || {})
  });
  return new Request('https://content-orchestrator.smileseon.workers.dev/mcp', {
    method: options.method || 'POST',
    headers,
    body: options.method === 'OPTIONS' ? undefined : JSON.stringify(body)
  });
}

function fakeDownstream(handler = null) {
  const calls = [];
  return {
    calls,
    async fetch(req) {
      calls.push({ url: req.url, method: req.method, admin: req.headers.get('x-admin-api-key'), body: req.method === 'GET' ? null : await req.clone().text() });
      if (handler) return handler(req, calls);
      return Response.json({ ok: true });
    }
  };
}

async function rpc(body, options = {}, downstream = fakeDownstream()) {
  const response = await handleMcpRequest(request(body, options), env, ctx, downstream);
  const data = response.status === 204 ? null : await response.json();
  return { response, data, downstream };
}

test('MCP endpoint requires authorization', async () => {
  const req = new Request('https://content-orchestrator.smileseon.workers.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  const response = await handleMcpRequest(req, env, ctx, fakeDownstream());
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Bearer/i);
});

test('legacy initialize advertises tools capability', async () => {
  const { response, data } = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_LEGACY, capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  });
  assert.equal(response.status, 200);
  assert.equal(data.result.protocolVersion, MCP_PROTOCOL_LEGACY);
  assert.equal(data.result.serverInfo.name, 'smileseon');
  assert.ok(data.result.capabilities.tools);
  assert.equal(data.result.resultType, undefined);
});

test('modern discovery is stateless and stamped', async () => {
  const { data } = await rpc({
    jsonrpc: '2.0', id: 'd1', method: 'server/discover',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_MODERN } }
  }, { headers: { 'MCP-Protocol-Version': MCP_PROTOCOL_MODERN, 'Mcp-Method': 'server/discover' } });
  assert.equal(data.result.resultType, 'complete');
  assert.ok(data.result.supportedVersions.includes(MCP_PROTOCOL_MODERN));
  assert.equal(data.result._meta['io.modelcontextprotocol/serverInfo'].name, 'smileseon');
});

test('modern tools/list returns cached private tool catalog', async () => {
  const { data } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {
    headers: { 'MCP-Protocol-Version': MCP_PROTOCOL_MODERN, 'Mcp-Method': 'tools/list' }
  });
  assert.equal(data.result.resultType, 'complete');
  assert.equal(data.result.cacheScope, 'private');
  assert.equal(data.result.ttlMs, 60000);
  assert.ok(data.result.tools.some((tool) => tool.name === 'smileseon_list_jobs'));
  assert.ok(data.result.tools.some((tool) => tool.name === 'smileseon_publish_tick'));
});

test('protected jobs 36-42 cannot be retried through MCP', async () => {
  for (const jobId of PROTECTED_JOB_IDS) {
    const downstream = fakeDownstream();
    const { data } = await rpc({
      jsonrpc: '2.0', id: jobId, method: 'tools/call',
      params: { name: 'smileseon_retry_job', arguments: { jobId } }
    }, {}, downstream);
    assert.equal(data.result.isError, true);
    assert.match(data.result.structuredContent.error, new RegExp(`MCP_PROTECTED_JOB_${jobId}`));
    assert.equal(downstream.calls.length, 0);
  }
});

test('tool calls reuse existing admin API path instead of bypassing safeguards', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') return Response.json({ jobs: [{ id: 95, status: 'failed' }], count: 1 });
    return Response.json({ ok: true });
  });
  const { data } = await rpc({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'smileseon_list_jobs', arguments: { limit: 20 } }
  }, {}, downstream);
  assert.equal(data.result.isError, undefined);
  assert.equal(data.result.structuredContent.count, 1);
  assert.equal(downstream.calls[0].admin, 'admin-secret');
  assert.match(downstream.calls[0].url, /\/api\/jobs\?limit=20/);
});

test('repair queue call reuses an active repair for the same Blogger Post ID', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') {
      return Response.json({ jobs: [{ id: 95, mode: 'repair_existing', blog_id: 'b1', blogger_post_id: 'p1', status: 'failed' }], count: 1 });
    }
    throw new Error(`unexpected call ${url.pathname}`);
  });
  const { data } = await rpc({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'smileseon_queue_repair_existing', arguments: { blogId: 'b1', bloggerPostId: 'p1' } }
  }, {}, downstream);
  assert.equal(data.result.structuredContent.reusedExisting, true);
  assert.equal(data.result.structuredContent.jobId, 95);
  assert.equal(downstream.calls.length, 1);
});

test('publish tick refuses if a protected job is unexpectedly ready', async () => {
  const downstream = fakeDownstream((req) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/jobs') return Response.json({ jobs: [{ id: 36, status: 'ready' }], count: 1 });
    throw new Error('publish path must not be reached');
  });
  const { data } = await rpc({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'smileseon_publish_tick', arguments: { skipImages: true } }
  }, {}, downstream);
  assert.equal(data.result.isError, true);
  assert.match(data.result.structuredContent.error, /MCP_PROTECTED_JOB_36_BLOCKS_PUBLISH_TICK/);
  assert.equal(downstream.calls.length, 1);
});

test('modern header mismatch is rejected before tool execution', async () => {
  const downstream = fakeDownstream();
  const { response, data } = await rpc({
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'smileseon_list_blogs', arguments: {} }
  }, { headers: { 'MCP-Protocol-Version': MCP_PROTOCOL_MODERN, 'Mcp-Method': 'tools/list', 'Mcp-Name': 'smileseon_list_blogs' } }, downstream);
  assert.equal(response.status, 400);
  assert.equal(data.error.code, -32020);
  assert.equal(downstream.calls.length, 0);
});

test('worker config routes /mcp through the production maintenance wrapper to the MCP entrypoint', () => {
  const wrangler = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
  const maintenanceEntry = readFileSync(new URL('../worker/maintenance-entry.js', import.meta.url), 'utf8');
  assert.match(wrangler, /"main": "worker\/maintenance-entry\.js"/);
  assert.match(maintenanceEntry, /import app from '\.\/mcp-entry\.js'/);
  assert.match(wrangler, /"\/mcp"/);
  assert.ok(MCP_TOOLS.length >= 10);
});
