function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildHubUrl(env, path) {
  const base = trimSlash(env.API_HUB_BASE_URL);
  if (!base) throw new Error('API_HUB_BASE_URL_REQUIRED');
  if (!path || !String(path).startsWith('/')) throw new Error('API_HUB_PATH_INVALID');
  return `${base}${path}`;
}

export function hubHeaders(env, extra = {}) {
  if (!env.HUB_API_KEY) throw new Error('HUB_API_KEY_REQUIRED');
  return {
    'content-type': 'application/json',
    'x-hub-api-key': env.HUB_API_KEY,
    ...extra
  };
}

export function hubRequestTimeoutMs(env, path = '', body = {}) {
  const providerMode = String(body?.providerMode || '').trim().toLowerCase();
  if (canonicalHubPath(path) === '/api/hub/image/generate' && providerMode === 'cloudflare') {
    const imageTimeout = Number(env?.HUB_CLOUDFLARE_IMAGE_TIMEOUT_MS ?? 30000);
    if (!Number.isFinite(imageTimeout)) return 30000;
    return Math.max(5000, Math.min(60000, Math.trunc(imageTimeout)));
  }
  const configured = Number(env?.HUB_REQUEST_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(configured)) return 60000;
  return Math.max(10, Math.min(180000, Math.trunc(configured)));
}

export function aiStagePacingMs(env, path) {
  const value = String(path || '');
  if (!value.startsWith('/api/hub/ai/')) return 0;
  const configured = Number(env?.AI_STAGE_PACING_MS ?? 0);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.max(3000, Math.min(5000, Math.trunc(configured)));
}

// Retained as an exported compatibility contract for diagnostics/tests. Public HTTPS is
// used only when no Service Binding exists; it is never a fallback from a live binding.
const SAFE_PUBLIC_FALLBACK_PATHS = new Set([
  '/api/hub/ai/topic',
  '/api/hub/ai/writer',
  '/api/hub/ai/critic',
  '/api/hub/ai/repair',
  '/api/hub/ai/diagnostics/cloudflare',
  '/api/blogger/blogs',
  '/api/blogger/post/get'
]);

const CANONICAL_PATH_SUFFIXES = [
  ['/diagnostics/cloudflare', '/api/hub/ai/diagnostics/cloudflare'],
  ['/blogger/post/get', '/api/blogger/post/get'],
  ['/blogger/blogs', '/api/blogger/blogs'],
  ['/image/generate', '/api/hub/image/generate'],
  ['/ai/topic', '/api/hub/ai/topic'],
  ['/ai/writer', '/api/hub/ai/writer'],
  ['/ai/critic', '/api/hub/ai/critic'],
  ['/ai/repair', '/api/hub/ai/repair'],
  ['/topic', '/api/hub/ai/topic'],
  ['/writer', '/api/hub/ai/writer'],
  ['/critic', '/api/hub/ai/critic'],
  ['/repair', '/api/hub/ai/repair']
];

const ROUTE_MISSING_CODES = new Set([
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'ROUTE_MISMATCH',
  'METHOD_NOT_ALLOWED'
]);

const SAFE_PROVIDER_CODE_PREFIXES = Object.freeze([
  'BLOGGER_',
  'GEMINI_',
  'KIE_',
  'CLOUDFLARE_',
  'WORKERS_AI_',
  'GOOGLE_',
  'TAVILY_',
  'IMAGE_',
  'WRITER_',
  'CRITIC_',
  'REPAIR_',
  'MASTER_',
  'API_HUB_BINDING_'
]);

const SAFE_PROVIDER_CODES = new Set([
  'RESOURCE_EXHAUSTED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'PROVIDER_ERROR'
]);

export function canonicalHubPath(path) {
  const value = String(path || '').trim();
  if (!value.startsWith('/')) return value;
  for (const [suffix, canonical] of CANONICAL_PATH_SUFFIXES) {
    if (value === canonical || value.endsWith(suffix)) return canonical;
  }
  return value;
}

export function hubPublicFallbackAllowed(path) {
  return SAFE_PUBLIC_FALLBACK_PATHS.has(String(path || ''));
}

export function hubPublicFallbackStatusAllowed(status) {
  const code = Number(status || 0);
  return code === 404 || code === 405;
}

function normalizedProviderCode(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  const sanitized = text.replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 96) || null;
}

function safePersistedProviderCode(value) {
  const code = normalizedProviderCode(value);
  if (!code) return null;
  if (ROUTE_MISSING_CODES.has(code) || SAFE_PROVIDER_CODES.has(code)) return code;
  if (SAFE_PROVIDER_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) return code;
  return null;
}

function isRouteMissingProviderCode(status, providerCode) {
  const httpStatus = Number(status || 0);
  const code = normalizedProviderCode(providerCode);
  if (![404, 405].includes(httpStatus) || !code) return false;
  if (!ROUTE_MISSING_CODES.has(code)) return false;
  if (httpStatus === 405) return code === 'METHOD_NOT_ALLOWED' || code === 'ROUTE_MISMATCH';
  return code !== 'METHOD_NOT_ALLOWED';
}

function serviceBindingFetch(env) {
  if (env?.API_HUB_SERVICE && typeof env.API_HUB_SERVICE.fetch === 'function') {
    return (url, init) => env.API_HUB_SERVICE.fetch(new Request(url, init));
  }
  return null;
}

async function readHubResponse(fetcher, url, init) {
  const response = await fetcher(url, init);
  const text = await response.text();
  return { response, text };
}

function parseHubResponse({ response, text }) {
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const providerError = typeof data?.error === 'string' ? data.error : null;
    const providerCode = safePersistedProviderCode(providerError);
    const hubCode = `API_HUB_${response.status}`;
    const routeMissing = isRouteMissingProviderCode(response.status, providerError);
    const error = new Error(providerError ? `${hubCode}:${providerError}` : hubCode);
    error.status = response.status;
    error.hubStatus = response.status;
    error.code = routeMissing ? hubCode : (providerCode || hubCode);
    error.providerCode = providerCode;
    error.routeMissing = routeMissing;
    error.data = data;
    throw error;
  }
  return data;
}

function bindingTransportError(cause) {
  const error = new Error('API_HUB_503:API_HUB_BINDING_FAILED');
  error.status = 503;
  error.hubStatus = 503;
  error.code = 'API_HUB_503';
  error.providerCode = 'API_HUB_BINDING_FAILED';
  error.routeMissing = false;
  error.cause = cause;
  return error;
}

async function callHubPath(env, path, body, fetchImpl) {
  const bindingFetch = serviceBindingFetch(env);
  const timeoutMs = hubRequestTimeoutMs(env, path, body);
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const error = new Error('API_HUB_TIMEOUT');
      error.code = 'API_HUB_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  const url = buildHubUrl(env, path);
  const init = {
    method: 'POST',
    headers: hubHeaders(env),
    body: JSON.stringify(body ?? {}),
    signal: controller.signal
  };

  try {
    const operation = (async () => {
      const pacingMs = aiStagePacingMs(env, path);
      if (pacingMs > 0) await sleep(pacingMs);
      if (!bindingFetch) return readHubResponse(fetchImpl, url, init);
      try {
        // In production the Service Binding is the authoritative and private transport.
        // Never replace a valid binding response (including 4xx/5xx) with workers.dev.
        return await readHubResponse(bindingFetch, url, init);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw bindingTransportError(error);
      }
    })();
    return parseHubResponse(await Promise.race([operation, timeout]));
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      const timeoutError = new Error('API_HUB_TIMEOUT');
      timeoutError.code = 'API_HUB_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isMissingRoute(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'API_HUB_404' || code === 'API_HUB_405';
}

export async function callHub(env, path, body, fetchImpl = fetch) {
  const requestedPath = String(path || '').trim();
  const canonicalPath = canonicalHubPath(requestedPath);
  try {
    return await callHubPath(env, requestedPath, body, fetchImpl);
  } catch (error) {
    if (!isMissingRoute(error) || !error?.routeMissing || !canonicalPath || canonicalPath === requestedPath) throw error;
    return callHubPath(env, canonicalPath, body, fetchImpl);
  }
}
