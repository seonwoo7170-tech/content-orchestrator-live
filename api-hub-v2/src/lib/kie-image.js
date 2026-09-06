const DEFAULT_KIE_BASE_URL = 'https://api.kie.ai';
const DEFAULT_KIE_MODEL = 'z-image';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PENDING_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running']);

function requiredKey(env) {
  const key = String(env?.KIE_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('KIE_API_KEY_REQUIRED'), { status: 503 });
  return key;
}

function safeBaseUrl(env) {
  const raw = String(env?.KIE_API_BASE_URL || DEFAULT_KIE_BASE_URL).trim();
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('KIE_API_BASE_URL_INVALID'), { status: 500 }); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.kie.ai') {
    throw Object.assign(new Error('KIE_API_BASE_URL_NOT_ALLOWED'), { status: 500 });
  }
  return url.origin;
}

function safeModel(env) {
  const model = String(env?.KIE_IMAGE_MODEL || DEFAULT_KIE_MODEL).trim();
  if (model !== DEFAULT_KIE_MODEL) throw Object.assign(new Error('KIE_IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  return model;
}

export function normalizeAspectRatio(value, role) {
  const ratio = String(value || '').trim();
  const fallback = role === 'thumbnail' ? '16:9' : '4:3';
  const allowed = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);
  if (allowed.has(ratio)) return ratio;
  if (ratio === '3:2') return '4:3';
  if (ratio === '2:3') return '3:4';
  return fallback;
}

export function safePromptForKie(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return prompt;

  const commonSafety = 'Photorealistic real-world image. Use plain unbranded objects and surfaces. No visible text, letters, numbers, logos, icons, UI, packaging, labels, documents, signs, or watermarks.';
  const monitorTopic = /(모니터|화면\s*깜빡|monitor|display|screen\s*flicker)/i.test(prompt);
  const cableTopic = /(케이블|물리적\s*연결|연결\s*상태|cable|connector|connection|port)/i.test(prompt);
  const computerHardwareTopic = /(desktop computer case|computer cooling fan|cooling fan housing|open unbranded desktop|metal desktop case|sleeved cable)/i.test(prompt);
  const tightRecovery = /(extreme tight close-up|minimum physical elements|completely out of frame)/i.test(prompt);
  const closeRecovery = /(close-up view|person.?s hands checking|exposed circuit boards are minimized)/i.test(prompt);

  if (computerHardwareTopic) {
    if (tightRecovery) {
      return `A photorealistic macro editorial photograph of a plain matte black metal desktop computer ventilation grille being gently brushed clean. Show only a small section of the regular round ventilation holes, soft gray brush bristles, and two fingertips. No internal computer components, ports, cables, screws, screens, keyboards, stickers, labels, or decorative details are visible. Broad uniform black surfaces, simple geometry, soft natural side light, shallow depth of field. ${commonSafety}`;
    }
    if (closeRecovery) {
      return `A photorealistic close editorial photograph of the smooth matte black exterior side panel of an unbranded desktop computer case on a clean workbench. One simple rectangular ventilation grille is being cleaned with a soft gray brush held by a hand. Keep all ports, cables, internal components, monitors, keyboards, stickers, labels, and documents out of frame. Broad uniform surfaces, minimal objects, soft natural daylight. ${commonSafety}`;
    }
    return `A photorealistic editorial photograph of a plain matte black unbranded desktop computer side panel resting on a clean wooden workbench. A hand uses a soft gray cleaning brush on one simple ventilation grille. Only the smooth case panel, regular ventilation holes, brush, and hand are visible. No ports, cables, internal components, screens, keyboards, stickers, labels, packaging, or documents. Soft natural daylight and a simple uncluttered composition. ${commonSafety}`;
  }

  if (monitorTopic && cableTopic) {
    return `${prompt}. Show the relevant monitor and cable connection clearly in a realistic clean setting. Keep any screen blank or out of frame. ${commonSafety}`;
  }
  if (monitorTopic) {
    return `${prompt}. Show a realistic desktop monitor with a blank featureless screen in a clean real-world setting. ${commonSafety}`;
  }
  return `${prompt}. ${commonSafety}`;
}

function numericCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function kieFailure(response, data, safeError) {
  const providerHttpStatus = numericCode(response?.status);
  const providerCode = numericCode(data?.code);
  const signals = new Set([providerHttpStatus, providerCode].filter((value) => value !== null));

  let message = safeError;
  let status = 502;
  if (signals.has(401) || signals.has(403)) {
    message = 'KIE_AUTH_FAILED';
    status = 401;
  } else if (signals.has(402)) {
    message = 'KIE_INSUFFICIENT_CREDITS';
    status = 402;
  } else if (signals.has(429)) {
    message = 'KIE_RATE_LIMITED';
    status = 429;
  } else if (signals.has(400) || signals.has(422)) {
    message = 'KIE_VALIDATION_FAILED';
    status = 422;
  } else if ([...signals].some((value) => value >= 500)) {
    message = 'KIE_PROVIDER_ERROR';
    status = 502;
  }

  return Object.assign(new Error(message), {
    status,
    providerHttpStatus,
    providerCode
  });
}

function kieTaskFailure(task) {
  const providerCode = numericCode(task?.failCode);
  const detail = String(task?.failMsg || '').trim().toLowerCase();
  let message = 'KIE_IMAGE_GENERATION_FAILED';
  let status = 502;

  if (providerCode === 429 || /rate.?limit|too many|concurrent/.test(detail)) {
    message = 'KIE_RATE_LIMITED';
    status = 429;
  } else if (/(moderator|content policy|policy violation|nsfw|inappropriate content)/.test(detail)) {
    message = 'KIE_CONTENT_REJECTED';
    status = 422;
  } else if (providerCode === 500 || providerCode === 501 || /internal error|try again later|generation failed|generate failed/.test(detail)) {
    message = 'KIE_PROVIDER_GENERATION_FAILED';
  }

  const error = Object.assign(new Error(message), { status });
  if (providerCode !== null) error.providerCode = providerCode;
  return error;
}

function kieResponseSucceeded(response, data) {
  if (!response?.ok || !data) return false;
  if (Number(data.code) === 200) return true;
  return Boolean(data.data) && String(data.msg || '').trim().toLowerCase() === 'success';
}

async function jsonRequest(fetchImpl, url, init, safeError) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error('KIE_NETWORK_ERROR'), { status: 502 });
  }
  let data = null;
  try { data = await response.json(); } catch { /* safe generic failure below */ }
  if (!kieResponseSucceeded(response, data)) throw kieFailure(response, data, safeError);
  return data;
}

function parseResultUrl(task) {
  let parsed;
  try { parsed = JSON.parse(String(task?.resultJson || '{}')); } catch { return ''; }
  const url = Array.isArray(parsed?.resultUrls) ? String(parsed.resultUrls[0] || '').trim() : '';
  if (!url) return '';
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return ''; }
  if (parsedUrl.protocol !== 'https:') return '';
  return parsedUrl.href;
}

function classifyMimeType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) return type;
  return 'image/jpeg';
}

async function downloadKieResult(fetchImpl, resultUrl) {
  let imageResponse;
  try { imageResponse = await fetchImpl(resultUrl, { redirect: 'follow' }); } catch {
    throw Object.assign(new Error('KIE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
  }
  if (!imageResponse.ok) throw Object.assign(new Error('KIE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error(bytes.length ? 'KIE_IMAGE_TOO_LARGE' : 'KIE_IMAGE_EMPTY'), { status: 502 });
  }

  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return {
    mimeType: classifyMimeType(imageResponse.headers?.get?.('content-type')),
    imageBase64: btoa(binary)
  };
}

export async function startKieImageTask(env, { role, prompt, aspectRatio }, fetchImpl = fetch) {
  const apiKey = requiredKey(env);
  const baseUrl = safeBaseUrl(env);
  const model = safeModel(env);
  const create = await jsonRequest(
    fetchImpl,
    `${baseUrl}/api/v1/jobs/createTask`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: {
          prompt: safePromptForKie(prompt),
          aspect_ratio: normalizeAspectRatio(aspectRatio, role),
          nsfw_checker: true
        }
      })
    },
    'KIE_CREATE_TASK_FAILED'
  );

  const taskId = String(create?.data?.taskId || '').trim();
  if (!taskId) throw Object.assign(new Error('KIE_TASK_ID_MISSING'), { status: 502 });
  return {
    ok: true,
    provider: 'kie-ai',
    model,
    taskId,
    state: 'waiting',
    pending: true,
    complete: false
  };
}

export async function pollKieImageTask(env, taskId, fetchImpl = fetch) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) throw Object.assign(new Error('KIE_TASK_ID_REQUIRED'), { status: 400 });
  const apiKey = requiredKey(env);
  const baseUrl = safeBaseUrl(env);
  const model = safeModel(env);
  const detail = await jsonRequest(
    fetchImpl,
    `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(normalizedTaskId)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
    'KIE_TASK_QUERY_FAILED'
  );
  const task = detail?.data || {};
  const state = String(task.state || '').trim().toLowerCase();
  if (state === 'fail') throw kieTaskFailure(task);
  if (state !== 'success') {
    return {
      ok: true,
      provider: 'kie-ai',
      model,
      taskId: normalizedTaskId,
      state: PENDING_STATES.has(state) ? state : (state || 'waiting'),
      pending: true,
      complete: false
    };
  }

  const resultUrl = parseResultUrl(task);
  if (!resultUrl) throw Object.assign(new Error('KIE_RESULT_URL_MISSING'), { status: 502 });
  const downloaded = await downloadKieResult(fetchImpl, resultUrl);
  return {
    ok: true,
    provider: 'kie-ai',
    model,
    taskId: normalizedTaskId,
    state: 'success',
    pending: false,
    complete: true,
    sourceUrl: resultUrl,
    ...downloaded
  };
}

export async function generateKieImage(env, { role, prompt, aspectRatio, taskId }, fetchImpl = fetch) {
  if (String(taskId || '').trim()) return pollKieImageTask(env, taskId, fetchImpl);
  return startKieImageTask(env, { role, prompt, aspectRatio }, fetchImpl);
}
