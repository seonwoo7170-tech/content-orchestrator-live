import { buildHubUrl, callHub, hubHeaders } from './api-hub.js';

const SAFE_PROVIDER_CODES = Object.freeze([
  'CLOUDFLARE_AI_ACCOUNT_LIMITED',
  'CLOUDFLARE_AI_OUT_OF_CAPACITY',
  'CLOUDFLARE_AI_PAID_PLAN_REQUIRED',
  'CLOUDFLARE_AI_TIMEOUT',
  'CLOUDFLARE_AI_EMPTY_RESPONSE',
  'CLOUDFLARE_AI_BINDING_FAILED'
]);

function safeDiagnosticCode(error) {
  const providerCode = String(error?.data?.error || error?.providerCode || error?.code || '');
  if (SAFE_PROVIDER_CODES.includes(providerCode)) return providerCode;

  const message = String(error?.message || '');
  const embedded = SAFE_PROVIDER_CODES.find((code) => message.includes(code));
  if (embedded) return embedded;
  if (/^API_HUB_\d{3}$/.test(message)) return message;
  if (/^HTTP_\d{3}$/.test(message)) return message;
  return 'DIAGNOSTIC_FAILED';
}

function providerState(code, status) {
  const value = String(code || '').toUpperCase();
  const http = Number(status || 0);
  if (http === 429 || /RATE_LIMIT|QUOTA|ACCOUNT_LIMITED|OUT_OF_CAPACITY|RESOURCE_EXHAUSTED/.test(value)) return 'limited';
  if (/AUTH|REQUIRED|NOT_CONFIGURED|DISABLED|PAID_PLAN_REQUIRED/.test(value)) return 'unavailable';
  if (/TIMEOUT|UNAVAILABLE|FAILED|EMPTY_RESPONSE/.test(value)) return 'unavailable';
  return 'error';
}

function stateLabel(state) {
  return {
    available: '정상',
    standby: '대기',
    configured: '설정됨',
    limited: '제한 중',
    disabled: '비활성',
    unconfigured: '미설정',
    unavailable: '사용 불가',
    error: '오류',
    unknown: '확인 필요'
  }[state] || '확인 필요';
}

export function sanitizeDiagnosticError(error) {
  return {
    ok: false,
    code: safeDiagnosticCode(error),
    status: Number(error?.status || 500),
    details: null
  };
}

async function callDiagnosticGet(env, path, fetchImpl) {
  const response = await fetchImpl(buildHubUrl(env, path), {
    method: 'GET',
    headers: hubHeaders(env)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`API_HUB_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function hubFetcher(env, fetchImpl) {
  if (env?.API_HUB_SERVICE && typeof env.API_HUB_SERVICE.fetch === 'function') {
    return (url, init) => env.API_HUB_SERVICE.fetch(new Request(url, init));
  }
  return fetchImpl;
}

async function readHubHealth(env, fetchImpl) {
  try {
    const response = await hubFetcher(env, fetchImpl)(buildHubUrl(env, '/health'), {
      method: 'GET',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function probeCloudflare(env, fetchImpl) {
  const path = env.HUB_CLOUDFLARE_DIAGNOSTIC_PATH || '/api/hub/ai/diagnostics/cloudflare';
  try {
    let data;
    try {
      data = await callHub(
        env,
        path,
        { model: '@cf/openai/gpt-oss-120b', prompt: 'Reply only with OK' },
        fetchImpl
      );
    } catch (error) {
      if (Number(error?.status) !== 405) throw error;
      data = await callDiagnosticGet(env, path, fetchImpl);
    }

    const response = String(data?.response ?? data?.result?.response ?? '').trim();
    return {
      ok: data?.ok !== false && /^ok[.!]?$/i.test(response),
      state: data?.ok !== false && /^ok[.!]?$/i.test(response) ? 'available' : 'unavailable',
      code: null,
      status: 200,
      model: data?.model || '@cf/openai/gpt-oss-120b',
      response: response || null,
      usage: data?.usage ?? data?.result?.usage ?? null
    };
  } catch (error) {
    const safe = sanitizeDiagnosticError(error);
    return {
      ...safe,
      state: providerState(safe.code, safe.status),
      model: '@cf/openai/gpt-oss-120b',
      response: null,
      usage: null
    };
  }
}

async function probeTextChain(env, fetchImpl) {
  const article = {
    title: 'AI connectivity test',
    html: '<p>This is a provider connectivity test.</p>',
    searchDescription: 'Provider connectivity test',
    labels: ['diagnostic'],
    sources: [],
    language: 'en',
    topic: 'AI connectivity test'
  };
  try {
    const data = await callHub(env, '/api/hub/ai/critic', { article }, fetchImpl);
    return {
      ok: true,
      provider: String(data?.provider || ''),
      model: data?.model || null,
      fallbackUsed: Boolean(data?.fallbackUsed),
      primaryError: data?.primaryError ? String(data.primaryError) : null,
      status: 200,
      code: null
    };
  } catch (error) {
    const safe = sanitizeDiagnosticError(error);
    return {
      ...safe,
      provider: null,
      model: null,
      fallbackUsed: false,
      primaryError: null
    };
  }
}

function configuredProvider(state, configured, enabled = true) {
  if (!configured) return { state: 'unconfigured', label: stateLabel('unconfigured'), configured: false, enabled: false };
  if (!enabled) return { state: 'disabled', label: stateLabel('disabled'), configured: true, enabled: false };
  return { state, label: stateLabel(state), configured: true, enabled: true };
}

function buildProviderSummary(health, cloudflare, chain) {
  const geminiConfigured = Boolean(health?.geminiConfigured);
  const freeAiConfigured = Boolean(health?.freeAiConfigured);
  const freeAiEnabled = Boolean(health?.freeAiFallbackEnabled);

  let gemini = configuredProvider('configured', geminiConfigured);
  let freeAi = configuredProvider('standby', freeAiConfigured, freeAiEnabled);
  let workers = {
    state: cloudflare.state,
    label: stateLabel(cloudflare.state),
    configured: true,
    enabled: true,
    code: cloudflare.code || null,
    status: cloudflare.status || null,
    model: cloudflare.model || null
  };

  if (chain?.ok) {
    if (chain.provider === 'google-gemini') {
      gemini = { ...gemini, state: 'available', label: stateLabel('available'), model: chain.model || health?.geminiCriticModel || null };
      if (freeAi.enabled) freeAi = { ...freeAi, state: 'standby', label: stateLabel('standby') };
    } else if (chain.provider === 'free-ai') {
      const geminiState = providerState(chain.primaryError, String(chain.primaryError || '').includes('RATE_LIMIT') ? 429 : 0);
      gemini = { ...gemini, state: geminiState, label: stateLabel(geminiState), code: chain.primaryError || null };
      freeAi = { ...freeAi, state: 'available', label: stateLabel('available'), model: chain.model || health?.freeAiCriticModel || null };
    } else if (chain.provider === 'cloudflare-workers-ai') {
      const geminiState = providerState(chain.primaryError, String(chain.primaryError || '').includes('RATE_LIMIT') ? 429 : 0);
      gemini = { ...gemini, state: geminiState, label: stateLabel(geminiState), code: chain.primaryError || null };
      if (freeAi.enabled) freeAi = { ...freeAi, state: 'unavailable', label: stateLabel('unavailable') };
      workers = { ...workers, state: 'available', label: stateLabel('available'), model: chain.model || workers.model };
    }
  } else if (!cloudflare.ok) {
    if (gemini.configured && gemini.state === 'configured') gemini = { ...gemini, state: 'unknown', label: stateLabel('unknown') };
    if (freeAi.enabled && freeAi.state === 'standby') freeAi = { ...freeAi, state: 'unknown', label: stateLabel('unknown') };
  }

  return {
    gemini,
    freeAi,
    workersAi: workers
  };
}

export async function diagnoseCloudflareViaHub(env, fetchImpl = fetch) {
  const [cloudflare, health] = await Promise.all([
    probeCloudflare(env, fetchImpl),
    readHubHealth(env, fetchImpl)
  ]);

  const chain = cloudflare.ok ? null : await probeTextChain(env, fetchImpl);
  const providers = buildProviderSummary(health, cloudflare, chain);
  const usable = Boolean(cloudflare.ok || chain?.ok);
  const activeProvider = chain?.ok ? chain.provider : (cloudflare.ok ? 'cloudflare-workers-ai' : null);
  const failureStatus = Number(cloudflare.status || chain?.status || 502);

  return {
    ok: usable,
    usable,
    overall: usable ? 'available' : 'unavailable',
    overallLabel: usable ? 'AI 사용 가능' : 'AI 사용 불가',
    activeProvider,
    providers,
    chain: chain ? {
      ok: chain.ok,
      provider: chain.provider,
      model: chain.model,
      fallbackUsed: chain.fallbackUsed,
      primaryError: chain.primaryError,
      code: chain.code || null,
      status: chain.status || null
    } : null,
    provider: 'cloudflare-workers-ai-via-api-hub',
    model: cloudflare.model,
    response: cloudflare.response,
    usage: cloudflare.usage,
    cloudflare,
    ...(usable ? {} : { code: cloudflare.code || chain?.code || 'DIAGNOSTIC_FAILED', status: failureStatus })
  };
}
