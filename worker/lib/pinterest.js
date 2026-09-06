const PINTEREST_API_BASE = 'https://api.pinterest.com/v5';
const DEFAULT_TIMEOUT_MS = 20000;

function safeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'PINTEREST_ERROR';
}

function requireHttps(value, code) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw Object.assign(new Error(code), { code }); }
  if (url.protocol !== 'https:') throw Object.assign(new Error(code), { code });
  return url.toString();
}

export function pinterestDeliveryConfigured(env) {
  return Boolean(String(env?.PINTEREST_ACCESS_TOKEN || '').trim());
}

export function buildPinterestCreatePayload(asset, settings = {}) {
  const boardId = String(settings.destinationId ?? settings.destination_id ?? '').trim();
  if (!boardId) throw Object.assign(new Error('PINTEREST_BOARD_REQUIRED'), { code: 'PINTEREST_BOARD_REQUIRED' });
  const imageUrl = requireHttps(asset?.imageUrl ?? asset?.image_url, 'PINTEREST_IMAGE_URL_INVALID');
  const link = requireHttps(asset?.trackedDestinationUrl ?? asset?.tracked_destination_url, 'PINTEREST_LINK_INVALID');
  const title = String(asset?.title || '').trim().slice(0, 100);
  const description = String(asset?.description || '').trim().slice(0, 500);
  if (!title) throw Object.assign(new Error('PINTEREST_TITLE_REQUIRED'), { code: 'PINTEREST_TITLE_REQUIRED' });
  return {
    link,
    title,
    description,
    board_id: boardId,
    media_source: {
      source_type: 'image_url',
      url: imageUrl,
      is_standard: true
    }
  };
}

export function classifyPinterestWriteFailure({ status = 0, error } = {}) {
  const numeric = Number(status || error?.status || 0);
  if (numeric === 429) return { code: 'PINTEREST_RATE_LIMIT', retryable: true, ambiguous: false };
  if ([401, 403].includes(numeric)) return { code: 'PINTEREST_AUTH_FAILED', retryable: false, ambiguous: false };
  if (numeric === 404) return { code: 'PINTEREST_DESTINATION_NOT_FOUND', retryable: false, ambiguous: false };
  if (numeric >= 500) return { code: `PINTEREST_HTTP_${numeric}`, retryable: false, ambiguous: true };
  if (numeric >= 400) return { code: `PINTEREST_HTTP_${numeric}`, retryable: false, ambiguous: false };
  const code = safeCode(error?.code || error?.name || error?.message);
  if (code.includes('TIMEOUT') || code.includes('ABORT') || code.includes('NETWORK') || code.includes('FETCH')) {
    return { code: 'PINTEREST_AMBIGUOUS_NETWORK', retryable: false, ambiguous: true };
  }
  return { code: 'PINTEREST_WRITE_FAILED', retryable: false, ambiguous: true };
}

export async function createPinterestPin(env, asset, settings = {}, fetchImpl = fetch) {
  if (env?.EXTERNAL_DISTRIBUTION_ENABLED !== 'true') {
    throw Object.assign(new Error('EXTERNAL_DISTRIBUTION_DISABLED'), { code: 'EXTERNAL_DISTRIBUTION_DISABLED', status: 503 });
  }
  const token = String(env?.PINTEREST_ACCESS_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('PINTEREST_ACCESS_TOKEN_MISSING'), { code: 'PINTEREST_ACCESS_TOKEN_MISSING', status: 503 });
  const payload = buildPinterestCreatePayload(asset, settings);
  const timeoutMs = Math.max(1000, Math.min(60000, Number(env?.PINTEREST_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${PINTEREST_API_BASE}/pins`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`PINTEREST_HTTP_${response.status}`);
      error.code = `PINTEREST_HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    const pinId = String(data?.id || '').trim();
    if (!pinId) throw Object.assign(new Error('PINTEREST_CREATE_RESULT_INVALID'), { code: 'PINTEREST_CREATE_RESULT_INVALID' });
    return { ok: true, pinId, boardId: String(data?.board_id || payload.board_id) };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error('PINTEREST_TIMEOUT');
      timeout.code = 'PINTEREST_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
