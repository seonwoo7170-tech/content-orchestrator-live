const RETRY_ACTION = 'retry-readable';
const REQUEST_TIMEOUT_MS = 8000;
const POLL_MS = 5000;
const MAX_WAIT_MS = 20 * 60 * 1000;
const ACTIVE_AI = new Set(['writing', 'critic_review', 'repairing', 'final_critic']);
let serialTail = Promise.resolve();
let queuedCount = 0;

function notify(message, tone = 'normal') {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    const data = parsePayload(text);
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP_${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function listJobs() {
  const data = await requestJson('/api/jobs?limit=100');
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

async function getJob(jobId) {
  const data = await requestJson(`/api/jobs/${jobId}`);
  return data?.job || null;
}

function markAccepted(button, position) {
  const card = button.closest('.job-row');
  const pill = card?.querySelector('.status-pill');
  if (pill) {
    pill.textContent = position > 1 ? `순차 재시도 ${position}번` : '순차 재시도 대기';
    pill.classList.remove('danger', 'success', 'neutral');
    pill.classList.add('active');
  }
}

async function waitUntilLaneFree(jobId) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const jobs = await listJobs();
    const busy = jobs.find((job) => ACTIVE_AI.has(String(job.status || '')) && Number(job.id) !== Number(jobId));
    if (!busy) return;
    await sleep(POLL_MS);
  }
  throw new Error('SERIAL_QUEUE_WAIT_TIMEOUT');
}

async function waitUntilJobStops(jobId) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    const job = await getJob(jobId).catch(() => null);
    if (!job || !ACTIVE_AI.has(String(job.status || ''))) return;
  }
  throw new Error('SERIAL_JOB_WAIT_TIMEOUT');
}

async function runWhenFree(jobId) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await waitUntilLaneFree(jobId);
    try {
      await requestJson(`/api/jobs/${jobId}/run`, { method: 'POST', body: '{}', keepalive: true });
      await waitUntilJobStops(jobId);
      return;
    } catch (error) {
      const code = String(error?.message || '').toUpperCase();
      if (error?.status === 409 || code.includes('ALREADY_CLAIMED') || code.includes('NOT_RUNNABLE')) {
        const job = await getJob(jobId).catch(() => null);
        if (job && ACTIVE_AI.has(String(job.status || ''))) {
          await waitUntilJobStops(jobId);
          return;
        }
        if (String(job?.status || '') === 'queued') {
          await sleep(POLL_MS);
          continue;
        }
      }
      throw error;
    }
  }
  throw new Error('SERIAL_START_TIMEOUT');
}

function queueSerialRun(jobId) {
  queuedCount += 1;
  const position = queuedCount;
  serialTail = serialTail
    .catch(() => {})
    .then(async () => {
      try {
        await runWhenFree(jobId);
      } catch (error) {
        console.warn('SERIAL_RETRY_RUN', { jobId, code: String(error?.message || error).slice(0, 80) });
      } finally {
        queuedCount = Math.max(0, queuedCount - 1);
        window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId } }));
      }
    });
  return position;
}

async function queuedAfterConflict(jobId) {
  try {
    const current = await getJob(jobId);
    return String(current?.status || '') === 'queued';
  } catch {
    return false;
  }
}

async function resetAndQueue(jobId, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '접수 중';
  try {
    let queueRun = false;
    try {
      await requestJson(`/api/jobs/${jobId}/retry`, { method: 'POST', body: '{}', keepalive: true });
      queueRun = true;
    } catch (error) {
      const code = String(error?.message || '').toUpperCase();
      if ((code.includes('JOB_NOT_RETRYABLE') || code.includes('JOB_RETRY_ALREADY_CLAIMED')) && await queuedAfterConflict(jobId)) {
        queueRun = true;
      } else {
        throw error;
      }
    }

    const position = queueRun ? queueSerialRun(jobId) : 0;
    button.textContent = '대기열 등록';
    markAccepted(button, position);
    notify(`작업 #${jobId} 재시도를 순차 처리 대기열 ${position || '-'}번에 넣었습니다.`);
  } catch (error) {
    const code = String(error?.message || 'RETRY_FAILED');
    notify(`다시 시도하지 못했습니다: ${code}`, 'danger');
  } finally {
    setTimeout(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      button.textContent = originalText;
    }, 1200);
  }
}

function retryButton(event) {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest(`button[data-action="${RETRY_ACTION}"]`);
  if (!(button instanceof HTMLButtonElement)) return null;
  const jobId = Number(button.dataset.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return null;
  return { button, jobId };
}

// Capture at window level for Android responsiveness, but never fan out into
// detached parallel AI runs. Every reset is handed to one local serial lane,
// while the server-side D1 claim is the final global concurrency guard.
window.addEventListener('click', (event) => {
  const retry = retryButton(event);
  if (!retry) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void resetAndQueue(retry.jobId, retry.button);
}, true);
