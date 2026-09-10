import { adminApi, isAdminConnected } from './admin-session.js';

const jobList = document.querySelector('#job-list');
const cursors = new Map();
const startedAt = new Map();
const jobMeta = new Map();
const openJobs = new Set();
let pollTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function ensureStyles() {
  if (document.querySelector('#job-live-log-styles')) return;
  const style = document.createElement('style');
  style.id = 'job-live-log-styles';
  style.textContent = `
    .job-log-action{border-color:#334155!important;background:#0f172a!important;color:#e2e8f0!important}
    .job-live-log{margin-top:12px;border:1px solid #243244;border-radius:12px;overflow:hidden;background:#08111f;color:#dbeafe}
    .job-live-log-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#0f172a;border-bottom:1px solid #243244}
    .job-live-log-head strong{font-size:12px;color:#f8fafc}.job-live-log-head span{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#94a3b8}
    .job-live-log-meta{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid #1e293b;background:#0b1525}
    .job-live-log-meta span{font-size:10px;padding:3px 7px;border-radius:999px;background:#172033;color:#cbd5e1}
    .job-live-log-list{height:260px;overflow:auto;margin:0;padding:10px 12px;list-style:none;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .job-live-log-list li{padding:4px 0;border-bottom:1px solid rgba(148,163,184,.08);word-break:break-word}
    .job-live-log-list time{color:#64748b;margin-right:7px}.job-live-log-list .log-info{color:#60a5fa}.job-live-log-list .log-success{color:#4ade80}.job-live-log-list .log-warn{color:#fbbf24}.job-live-log-list .log-error{color:#f87171}
    .job-live-log-empty{color:#64748b!important}.job-live-log-error{color:#f87171!important}
  `;
  document.head.appendChild(style);
}

function timeText(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(date);
}

function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`;
}

function rememberEvent(event) {
  const jobId = Number(event.job_id);
  const current = jobMeta.get(jobId) || { repair: 0, maxRepair: 2, stage: '대기' };
  if (event?.meta?.repairAttempt !== undefined) current.repair = Number(event.meta.repairAttempt) || current.repair;
  if (event?.meta?.maxRepairAttempts !== undefined) current.maxRepair = Number(event.meta.maxRepairAttempts) || current.maxRepair;
  if (/부분보완/.test(String(event.message || '')) && event?.meta?.repairAttempt === undefined) current.repair += 1;
  if (event.stage) current.stage = event.stage;
  jobMeta.set(jobId, current);
  if (!startedAt.has(jobId)) {
    const when = new Date(event.created_at).getTime();
    if (Number.isFinite(when)) startedAt.set(jobId, when);
  }
}

function updateMeta(panel, jobId) {
  const meta = panel.querySelector('.job-live-log-meta');
  if (!meta) return;
  const state = jobMeta.get(jobId) || { repair: 0, maxRepair: 2, stage: '대기' };
  const start = startedAt.get(jobId) || Date.now();
  meta.innerHTML = `<span>현재 ${escapeHtml(state.stage)}</span><span>Repair ${escapeHtml(state.repair)}/${escapeHtml(state.maxRepair)}</span><span data-elapsed>경과 ${elapsedText(Date.now() - start)}</span>`;
}

function appendEvents(panel, events) {
  const list = panel.querySelector('.job-live-log-list');
  if (!list) return;
  list.querySelector('.job-live-log-empty')?.remove();
  for (const event of events) {
    rememberEvent(event);
    if (list.querySelector(`[data-event-id="${Number(event.id)}"]`)) continue;
    const row = document.createElement('li');
    row.dataset.eventId = String(event.id);
    const level = ['success','warn','error'].includes(String(event.level)) ? event.level : 'info';
    row.innerHTML = `<time>[${escapeHtml(timeText(event.created_at))}]</time><span class="log-${level}">#${escapeHtml(event.job_id)} ${escapeHtml(event.message)}</span>`;
    list.appendChild(row);
  }
  if (events.length) list.scrollTop = list.scrollHeight;
  updateMeta(panel, Number(panel.dataset.jobLog));
}

async function refreshJob(jobId) {
  const panel = jobList?.querySelector(`[data-job-log="${jobId}"]`);
  if (!panel || panel.hidden || !isAdminConnected() || panel.dataset.loading === 'true') return;
  panel.dataset.loading = 'true';
  try {
    const after = cursors.get(jobId) || 0;
    const data = await adminApi(`/api/jobs/${jobId}/events?after=${after}&limit=60`);
    const events = Array.isArray(data.events) ? data.events : [];
    appendEvents(panel, events);
    if (events.length) cursors.set(jobId, Number(events[events.length - 1].id) || after);
    const state = panel.querySelector('[data-log-state]');
    if (state) state.textContent = events.length ? '실시간' : '새 로그 대기';
  } catch (error) {
    const state = panel.querySelector('[data-log-state]');
    if (state) state.textContent = `로그 오류: ${error.message}`;
  } finally {
    panel.dataset.loading = 'false';
  }
}

function refreshOpenJobs() {
  if (document.hidden) return;
  for (const jobId of openJobs) void refreshJob(jobId);
}

function ensurePolling() {
  if (pollTimer || !openJobs.size) return;
  pollTimer = setInterval(refreshOpenJobs, 5000);
}

function stopPollingIfIdle() {
  if (openJobs.size || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function buildPanel(jobId) {
  const panel = document.createElement('section');
  panel.className = 'job-live-log';
  panel.dataset.jobLog = String(jobId);
  panel.hidden = !openJobs.has(jobId);
  panel.innerHTML = `
    <div class="job-live-log-head"><strong>상세 진행 로그 · #${jobId}</strong><span data-log-state>연결 대기</span></div>
    <div class="job-live-log-meta"><span>현재 대기</span><span>Repair 0/2</span><span data-elapsed>경과 0초</span></div>
    <ul class="job-live-log-list"><li class="job-live-log-empty">기록된 진행 로그를 불러옵니다.</li></ul>`;
  updateMeta(panel, jobId);
  return panel;
}

function enhanceCard(card) {
  if (!card || card.dataset.logEnhanced === 'true') return;
  const jobId = Number(card.dataset.job);
  const actions = card.querySelector('.job-actions');
  if (!Number.isInteger(jobId) || !actions) return;
  card.dataset.logEnhanced = 'true';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button small ghost card-action job-log-action';
  button.dataset.action = 'job-live-log';
  button.dataset.jobId = String(jobId);
  button.textContent = openJobs.has(jobId) ? '로그 닫기' : '상세 로그';
  actions.appendChild(button);
  const panel = buildPanel(jobId);
  card.appendChild(panel);
  if (openJobs.has(jobId)) void refreshJob(jobId);
}

function enhanceAll() {
  jobList?.querySelectorAll('.job-row').forEach(enhanceCard);
  ensurePolling();
}

jobList?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="job-live-log"]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const jobId = Number(button.dataset.jobId);
  const card = button.closest('.job-row');
  const panel = card?.querySelector(`[data-job-log="${jobId}"]`);
  if (!panel || !Number.isInteger(jobId)) return;
  if (openJobs.has(jobId)) {
    openJobs.delete(jobId);
    panel.hidden = true;
    button.textContent = '상세 로그';
    stopPollingIfIdle();
  } else {
    openJobs.add(jobId);
    panel.hidden = false;
    button.textContent = '로그 닫기';
    void refreshJob(jobId);
    ensurePolling();
  }
}, true);

window.addEventListener('orchestrator:jobs-changed', () => {
  enhanceAll();
  refreshOpenJobs();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshOpenJobs();
});

if (jobList) {
  ensureStyles();
  new MutationObserver(enhanceAll).observe(jobList, { childList: true, subtree: false });
  enhanceAll();
}
