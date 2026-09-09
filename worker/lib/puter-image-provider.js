const DEFAULT_API_ORIGIN = 'https://api.puter.com';
const DEFAULT_MODELS = ['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback, min = 1, max = 600_000) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function apiOrigin(env = {}) {
  return String(env.PUTER_API_ORIGIN || DEFAULT_API_ORIGIN).trim().replace(/\/+$/, '');
}

export function puterImageConfigured(env = {}) {
  return String(env.PUTER_IMAGE_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
    && Boolean(String(env.PUTER_AUTH_TOKEN || '').trim());
}

export function puterImageModels(env = {}) {
  const configured = String(env.PUTER_IMAGE_MODELS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return configured.length ? configured.slice(0, 4) : [...DEFAULT_MODELS];
}

export function puterCheckpointPath(jobId, image) {
  const safeJobId = Math.max(1, Math.trunc(Number(jobId) || 0));
  const safeImageId = Math.max(1, Math.trunc(Number(image?.id) || 0));
  return `~/smileseon-image-${safeJobId}-${safeImageId}.png`;
}

export function puterCheckpointTaskId(jobId, image) {
  return `puterfs:${puterCheckpointPath(jobId, image)}`;
}

function ratioForImage(image = {}) {
  return image.role === 'thumbnail' ? { w: 16, h: 9 } : { w: 4, h: 3 };
}

function mimeFromDataUri(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(String(value || ''));
  return match ? match[1].toLowerCase() : null;
}

function base64FromDataUri(value) {
  const text = String(value || '');
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : '';
}

function bytesFromBase64(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function safeImageMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mime) ? mime : 'image/png';
}

function puterErrorCode(status, body = {}) {
  const text = [body?.code, body?.error?.code, body?.errorCode, body?.error?.errorCode, body?.message, body?.error?.message]
    .filter(Boolean).join(' ').toLowerCase();
  if (status === 401 || /token_auth_failed|unauthorized/.test(text)) return 'PUTER_AUTH_FAILED';
  if (status === 402 || /insufficient_funds|usage limit|quota|out of credits|insufficient credit/.test(text)) return 'PUTER_INSUFFICIENT_FUNDS';
  if (status === 429 || /rate limit|too many|concurrent/.test(text)) return 'PUTER_RATE_LIMITED';
  if (/moderation_flagged|content filter|safety|blocked/.test(text)) return 'PUTER_CONTENT_REJECTED';
  if (/model not found|unknown model|invalid model/.test(text)) return 'PUTER_MODEL_UNAVAILABLE';
  if (/upstream_failed|provider.*failed|generation failed/.test(text)) return 'PUTER_UPSTREAM_FAILED';
  if (status >= 500) return 'PUTER_UPSTREAM_FAILED';
  return `PUTER_PROVIDER_ERROR_${status || 'UNKNOWN'}`;
}

function puterError(code, detail = '') {
  const error = new Error(`${code}${detail ? `:${String(detail).slice(0, 180)}` : ''}`);
  error.code = code;
  return error;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

async function readPuterCheckpoint(env, path, fetchImpl = fetch) {
  const token = String(env.PUTER_AUTH_TOKEN || '').trim();
  if (!token) throw puterError('PUTER_NOT_CONFIGURED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInt(env.PUTER_IMAGE_READ_TIMEOUT_MS, 20_000, 3_000, 60_000));
  try {
    const response = await fetchImpl(`${apiOrigin(env)}/read?file=${encodeURIComponent(path)}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'cache-control': 'no-cache',
        pragma: 'no-cache'
      },
      signal: controller.signal
    });
    if (response.status === 404) return null;
    if (response.status === 401) throw puterError('PUTER_AUTH_FAILED');
    if (!response.ok) throw puterError(`PUTER_CHECKPOINT_READ_${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw puterError('PUTER_IMAGE_BYTES_INVALID');
    return { bytes, mimeType: safeImageMime(response.headers.get('content-type')) };
  } catch (error) {
    if (error?.name === 'AbortError') throw puterError('PUTER_CHECKPOINT_READ_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedResultUrl(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    for (const key of ['src', 'asset_url', 'url', 'href']) {
      if (typeof result[key] === 'string' && result[key]) return result[key];
    }
  }
  return '';
}

async function imageFromResult(result, fetchImpl = fetch) {
  const source = normalizedResultUrl(result);
  if (!source) throw puterError('PUTER_IMAGE_RESPONSE_INVALID');
  if (source.startsWith('data:image/')) {
    const mimeType = mimeFromDataUri(source);
    const bytes = bytesFromBase64(base64FromDataUri(source));
    if (!mimeType || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw puterError('PUTER_IMAGE_RESPONSE_INVALID');
    return { bytes, mimeType };
  }
  if (!/^https:\/\//i.test(source)) throw puterError('PUTER_IMAGE_RESPONSE_INVALID');
  const response = await fetchImpl(source, { redirect: 'follow' });
  if (!response.ok) throw puterError(`PUTER_IMAGE_DOWNLOAD_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw puterError('PUTER_IMAGE_BYTES_INVALID');
  return { bytes, mimeType: safeImageMime(response.headers.get('content-type')) };
}

function qualityForModel(model, env = {}) {
  if (model === 'gemini-3.1-flash-lite-image') return String(env.PUTER_IMAGE_QUALITY || '1K');
  if (/gemini-3\.1-flash-image/i.test(model)) return String(env.PUTER_IMAGE_QUALITY || '1K');
  return null;
}

async function driverGenerate(env, { prompt, model, outputPath, image }, fetchImpl = fetch) {
  const token = String(env.PUTER_AUTH_TOKEN || '').trim();
  if (!token) throw puterError('PUTER_NOT_CONFIGURED');
  const args = {
    prompt,
    model,
    ratio: ratioForImage(image),
    puter_output_path: outputPath
  };
  const quality = qualityForModel(model, env);
  if (quality) args.quality = quality;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInt(env.PUTER_IMAGE_TIMEOUT_MS, 120_000, 15_000, 180_000));
  try {
    const response = await fetchImpl(`${apiOrigin(env)}/drivers/call`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;actually=json' },
      body: JSON.stringify({
        interface: 'puter-image-generation',
        method: 'generate',
        args,
        auth_token: token
      }),
      signal: controller.signal
    });
    const body = await parseJsonResponse(response);
    if (!response.ok || body?.success === false) {
      const code = puterErrorCode(response.status, body);
      throw puterError(code, body?.error?.message || body?.message || body?.error?.code || '');
    }
    return body?.result !== undefined ? body.result : body;
  } catch (error) {
    if (error?.name === 'AbortError') throw puterError('PUTER_OUTCOME_UNKNOWN');
    if (error?.code) throw error;
    throw puterError('PUTER_OUTCOME_UNKNOWN', error?.message || 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

function isExplicitSafeRetry(code) {
  return code === 'PUTER_RATE_LIMITED' || code === 'PUTER_UPSTREAM_FAILED' || code === 'PUTER_MODEL_UNAVAILABLE';
}

function isOutcomeUnknown(image = {}) {
  return String(image?.provider_status || '').toLowerCase() === 'outcome_unknown'
    || /PUTER_OUTCOME_UNKNOWN/i.test(String(image?.provider_error_code || image?.provider_error_message || ''));
}

function checkpointAgeMs(image = {}) {
  const raw = String(image?.provider_checked_at || image?.updated_at || '').trim();
  const time = raw ? Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : Number.MAX_SAFE_INTEGER;
}

export async function generatePuterImage(env, jobId, image, prompt, options = {}) {
  if (!puterImageConfigured(env)) throw puterError('PUTER_NOT_CONFIGURED');
  const fetchImpl = options.fetchImpl || fetch;
  const path = puterCheckpointPath(jobId, image);

  // Always prefer a durable Puter filesystem checkpoint before any new billable generation.
  const existing = await readPuterCheckpoint(env, path, fetchImpl).catch((error) => {
    if (/PUTER_CHECKPOINT_READ_(?:404|TIMEOUT)/.test(String(error?.message || ''))) return null;
    throw error;
  });
  if (existing) {
    return {
      provider: 'puter',
      model: String(image?.model || 'puter-checkpoint'),
      mimeType: existing.mimeType,
      imageBytes: existing.bytes,
      checkpointPath: path,
      recovered: true
    };
  }

  // If a prior request timed out after Puter may already have accepted it, do not immediately
  // spend again. Give the deterministic filesystem checkpoint time to appear first.
  if (isOutcomeUnknown(image)) {
    const graceMs = positiveInt(env.PUTER_OUTCOME_UNKNOWN_GRACE_MS, 10 * 60_000, 60_000, 30 * 60_000);
    if (checkpointAgeMs(image) < graceMs) {
      throw puterError('PUTER_OUTCOME_UNKNOWN_WAIT');
    }
    throw puterError('PUTER_OUTCOME_UNKNOWN_EXPIRED');
  }

  const models = puterImageModels(env);
  let lastError = null;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await driverGenerate(env, { prompt, model, outputPath: path, image }, fetchImpl);
        // Prefer the filesystem copy because it is the durable, idempotent checkpoint.
        const checkpoint = await readPuterCheckpoint(env, path, fetchImpl).catch(() => null);
        const resolved = checkpoint || await imageFromResult(result, fetchImpl);
        return {
          provider: 'puter',
          model,
          mimeType: resolved.mimeType,
          imageBytes: resolved.bytes,
          checkpointPath: path,
          recovered: Boolean(checkpoint)
        };
      } catch (error) {
        lastError = error;
        const code = String(error?.code || error?.message || '');
        if (code.includes('PUTER_OUTCOME_UNKNOWN') || code.includes('PUTER_AUTH_FAILED') || code.includes('PUTER_INSUFFICIENT_FUNDS') || code.includes('PUTER_CONTENT_REJECTED')) throw error;
        if (!isExplicitSafeRetry(error?.code) || attempt >= maxAttempts) break;
        await sleep(attempt === 1 ? 2_000 : 5_000);
      }
    }
  }
  throw lastError || puterError('PUTER_PROVIDER_ERROR_UNKNOWN');
}
