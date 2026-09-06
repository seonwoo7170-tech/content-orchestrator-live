import { requireAdmin } from './admin-auth.js';
import { callHub, hubRequestTimeoutMs } from './api-hub.js';

export const HUB_WRITER_TRANSPORT_DIAGNOSTIC_PATH = '/api/diagnostics/hub-writer-transport';
const WRITER_PATH = '/api/hub/ai/writer';
const WRITER_PAYLOAD = Object.freeze({
  blogId: '7741529904469657049',
  topic: '2026 추석 명절 지원금',
  language: 'ko',
  candidateAttempt: 1
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function safeProviderSummary(data) {
  return {
    error: typeof data?.error === 'string' ? data.error.slice(0, 96) : null,
    providerCode: Number.isInteger(data?.providerCode) ? data.providerCode : null,
    providerHttpStatus: Number.isInteger(data?.providerHttpStatus) ? data.providerHttpStatus : null,
    provider: typeof data?.provider === 'string' ? data.provider.slice(0, 64) : null,
    model: typeof data?.model === 'string' ? data.model.slice(0, 96) : null,
    fallbackUsed: typeof data?.fallbackUsed === 'boolean' ? data.fallbackUsed : null,
    hasArticle: Boolean(data?.article)
  };
}

async function summarizeResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, ok: response.ok, ...safeProviderSummary(data) };
}

function writerInit(env) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-api-key': env.HUB_API_KEY },
    body: JSON.stringify(WRITER_PAYLOAD)
  };
}

async function directBindingProbe(env, url) {
  if (!env.API_HUB_SERVICE || typeof env.API_HUB_SERVICE.fetch !== 'function') {
    return { available: false, status: null, ok: false, error: 'SERVICE_BINDING_UNAVAILABLE' };
  }
  try {
    const response = await env.API_HUB_SERVICE.fetch(new Request(url, {
      ...writerInit(env),
      signal: AbortSignal.timeout(hubRequestTimeoutMs(env))
    }));
    return { available: true, ...(await summarizeResponse(response)) };
  } catch (error) {
    return { available: true, status: null, ok: false, error: String(error?.name || error?.code || 'BINDING_FETCH_FAILED').slice(0, 96) };
  }
}

async function managedProbe(env) {
  try {
    const data = await callHub(env, WRITER_PATH, WRITER_PAYLOAD);
    return {
      status: 200,
      ok: true,
      code: null,
      providerCode: null,
      routeMissing: false,
      provider: typeof data?.provider === 'string' ? data.provider.slice(0, 64) : null,
      fallbackUsed: typeof data?.fallbackUsed === 'boolean' ? data.fallbackUsed : null,
      hasArticle: Boolean(data?.article)
    };
  } catch (error) {
    return {
      status: Number.isInteger(error?.status) ? error.status : null,
      ok: false,
      code: typeof error?.code === 'string' ? error.code.slice(0, 96) : null,
      providerCode: typeof error?.providerCode === 'string' ? error.providerCode.slice(0, 96) : null,
      routeMissing: error?.routeMissing === true,
      provider: null,
      fallbackUsed: null,
      hasArticle: false
    };
  }
}

export async function handleHubWriterTransportDiagnostic(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  if (!env.HUB_API_KEY || !env.API_HUB_BASE_URL) return json({ error: 'API_HUB_NOT_CONFIGURED' }, 503);

  const base = String(env.API_HUB_BASE_URL).replace(/\/+$/, '');
  const url = `${base}${WRITER_PATH}`;
  const bindingAvailable = Boolean(env.API_HUB_SERVICE && typeof env.API_HUB_SERVICE.fetch === 'function');
  const binding = await directBindingProbe(env, url);
  const managed = await managedProbe(env);

  return json({
    ok: bindingAvailable ? Boolean(binding.ok && managed.ok) : Boolean(managed.ok),
    diagnostic: 'hub-writer-transport',
    writerPath: WRITER_PATH,
    transportPolicy: bindingAvailable ? 'service-binding-authoritative' : 'public-https-no-binding',
    binding,
    publicHttps: bindingAvailable
      ? { skipped: true, reason: 'SERVICE_BINDING_AUTHORITATIVE' }
      : { skipped: true, reason: 'MANAGED_PROBE_USES_PUBLIC_HTTPS' },
    managed
  });
}
