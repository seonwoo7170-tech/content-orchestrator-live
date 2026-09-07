const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function systemPaused(env = {}) {
  return String(env?.SYSTEM_PAUSED ?? 'true').trim().toLowerCase() !== 'false';
}

export function mutationBlocked(request, env = {}) {
  if (!systemPaused(env)) return false;
  return !SAFE_METHODS.has(String(request?.method || 'GET').toUpperCase());
}

export function pausedMutationResponse() {
  return new Response(JSON.stringify({
    ok: false,
    error: 'SYSTEM_PAUSED',
    systemPaused: true
  }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function augmentHealthResponse(response, paused) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return response;

  let body;
  try {
    body = await response.json();
  } catch {
    return response;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return response;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...body, systemPaused: Boolean(paused) }), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
