import { adminApi, isAdminConnected } from './admin-session.js';

const ACTIVE_AI = new Set(['writing', 'critic_review', 'repairing', 'final_critic']);
const ACTIVE_ALL = new Set([...ACTIVE_AI, 'updating_existing', 'publishing_new']);
const PROTECTED = new Set([36, 37, 38, 39, 40, 41, 42]);
const POLL_MS = 5000;
const MANUAL_WAIT_MS = 5000;
const MANUAL_MAX_WAIT_MS = 20 * 60 * 1000;

let host = null;
let pollTimer = null;
let refreshPromise = null;
let manualQueue = [];
let manualDraining = false;
let lastImageDiagnostics = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTime(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.endsWith('Z') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = normalizeTime(value);
  if (!date) return value ? String(value) : '-';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function shortSubject(job) {
  const topic = String(job?.topic || '').trim();
  if (topic) return topic;
  const target = String(job?.target_url || '').trim();
  if (target) {
    try {
      const url = new URL(target);
      const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
      return path || url.hostname;
    } catch { return target; }
  }
  return job?.blogger_post_id ? `Blogger Post ${job.blogger_post_id}` : `작업 #${job?.id || '-'}`;
}

function stageLabel(status, mode) {
  const repair = mode === 'repair_existing';
  const labels = {
    queued: '실행 순서 대기',
    writing: repair ? '기존 글 전체 재작성' : '새 글 작성',
    critic_review: 'Critic 검수',
    repairing: '문제 부분 보완',
    final_critic: '최종 Critic 검수',
    ready: '이미지 처리',
    updating_existing: '기존 Blogger 글 업데이트',
    publishing_new: 'Blogger 신규 발행',
    completed: repair ? '리페어 완료' : '발행 완료',
    needs_review: '추가 확인 필요',
    failed: '재시도 대기'
  };
  return labels[status] || status || '상태 확인 중';
}

function stagesFor(job) {
  if (job?.mode === 'repair_existing') {
    return [
      ['source', '원문 확인'],
      ['writing', '전체 재작성'],
      ['critic_review', 'Critic'],
      ['repairing', '부분 보완'],
      ['final_critic', '최종 Critic'],
      ['ready', '이미지'],
      ['updating_existing', 'Blogger 업데이트']
    ];
  }
  return [
    ['writing', '글 작성'],
    ['critic_review', 'Critic'],
    ['repairing', '부분 보완'],
    ['final_critic', '최종 Critic'],
    ['ready', '이미지'],
    ['publishing_new', 'Blogger 발행']
  ];
}

function stageIndex(job, stages) {
  const status = String(job?.status || '');
  const index = stages.findIndex(([key]) => key === status);
  if (index >= 0) return index;
  if (status === 'completed') return stages.length;
  if (job?.mode === 'repair_existing' && status === 'writing') return 1;
  return -1;
}

function progressHtml(job) {
  const stages = stagesFor(job);
  const current = stageIndex(job, stages);
  return `<div class="live-stage-track" aria-label="작업 단계">${stages.map(([key, label], index) => {
    const done = current > index;
    const active = current === index;
    return `<div class="live-stage ${done ? 'done' : ''} ${active ? 'active' : ''}">
      <span class="live-stage-dot">${done ? '✓' : index + 1}</span><small>${escapeHtml(label)}</small>
    </div>`;
  }).join('')}</div>`;
}

function queueCandidates(jobs) {
  const retry = jobs
    .filter((job) => String(job.recovery_state || '') === 'retry_wait' && !PROTECTED.has(Number(job.id)))
    .sort((a, b) => {
      const at = normalizeTime(a.next_retry_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = normalizeTime(b.next_retry_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt || Number(a.id) - Number(b.id);
    });
  const queued = jobs
    .filter((job) => String(job.status || '') === 'queued' && !PROTECTED.has(Number(job.id)))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const seen = new Set();
  return [...retry, ...queued].filter((job) => {
    if (seen.has(Number(job.id))) return false;
    seen.add(Number(job.id));
    return true;
  });
}

function currentJob(jobs) {
  return jobs
    .filter((job) => ACTIVE_ALL.has(String(job.status || '')) && !PROTECTED.has(Number(job.id)))
    .sort((a, b) => Number(a.id) - Number(b.id))[0] || null;
}

function imageStatePriority(value) {
  const priorities = { generating: 0, attaching: 1, failed: 2, planned: 3, waiting: 4 };
  return priorities[String(value || '')] ?? 5;
}

function currentImageWork(jobs, diagnostics) {
  const missing = Array.isArray(diagnostics?.missing) ? diagnostics.missing : [];
  if (!missing.length) return null;
  const jobsById = new Map(jobs.map((job) => [Number(job.id), job]));
  return missing
    .map((item) => ({ ...item, job: jobsById.get(Number(item.jobId)) || null }))
    .filter((item) => item.job && !PROTECTED.has(Number(item.jobId)))
    .sort((a, b) => {
      const priority = imageStatePriority(a.imageState) - imageStatePriority(b.imageState);
      if (priority) return priority;
      const at = normalizeTime(a.updatedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = normalizeTime(b.updatedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt || Number(a.jobId) - Number(b.jobId);
    })[0] || null;
}

function imageStateLabel(image) {
  const labels = {
    generating: '이미지 생성 중',
    attaching: '이미지 첨부 중',
    failed: '이미지 재시도 대기',
    planned: '이미지 생성 대기',
    waiting: '이미지 생성 대기',
    complete: '이미지 완료'
  };
  return labels[String(image?.imageState || '')] || '이미지 처리 중';
}

function prettyProvider(value) {
  const text = String(value || '').trim();
  if (!text || text === 'unassigned') return '';
  if (/kie/i.test(text)) return 'KIE';
  if (/cloudflare/i.test(text)) return 'Cloudflare';
  return text;
}

function imageProviderLabel(image, diagnostics) {
  const providers = Array.isArray(image?.providers) ? image.providers.map(prettyProvider).filter(Boolean) : [];
  if (providers.length) return [...new Set(providers)].join(' → ');
  if (diagnostics?.configuredProviderMode === 'auto') return 'KIE 우선';
  return prettyProvider(diagnostics?.configuredProviderMode) || 'KIE 우선';
}

function imageProgressLabel(image) {
  const current = Number(image?.current || 0);
  const target = Number(image?.target || 0);
  if (target > 0) return `${current}/${target}장`;
  const missing = Number(image?.missing || 0);
  return missing > 0 ? `${missing}장 남음` : '상태 확인 중';
}

function renderContentLane(active) {
  if (!active) {
    return `<div class="live-lane-card idle">
      <div class="live-lane-head"><strong>글 작업</strong><span class="live-lane-state neutral">대기</span></div>
      <p class="live-note">현재 작성·검수·Blogger 작업은 없습니다.</p>
    </div>`;
  }
  return `<div class="live-lane-card">
    <div class="live-lane-head">
      <div><span class="live-pulse" aria-hidden="true"></span><strong>글 작업</strong></div>
      <span class="live-lane-state">${escapeHtml(stageLabel(active.status, active.mode))}</span>
    </div>
    <div class="live-subject"><span>#${Number(active.id)}</span><b>${escapeHtml(shortSubject(active))}</b></div>
    <div class="live-meta"><span>${active.mode === 'repair_existing' ? '기존글 리페어' : '신규 글'}</span><span>30초 순차 처리</span></div>
    ${progressHtml(active)}
  </div>`;
}

function renderImageLane(image, diagnostics) {
  const backlog = Number(diagnostics?.totals?.readyMissingImages || 0);
  if (!image) {
    return `<div class="live-lane-card idle">
      <div class="live-lane-head"><strong>이미지 작업</strong><span class="live-lane-state neutral">대기 없음</span></div>
      <p class="live-note">현재 생성하거나 첨부할 이미지가 없습니다.</p>
    </div>`;
  }
  const job = image.job;
  return `<div class="live-lane-card image-lane">
    <div class="live-lane-head">
      <div><span class="live-pulse image" aria-hidden="true"></span><strong>이미지 작업</strong></div>
      <span class="live-lane-state image">${escapeHtml(imageStateLabel(image))}</span>
    </div>
    <div class="live-subject"><span>#${Number(job.id)}</span><b>${escapeHtml(shortSubject(job))}</b></div>
    <div class="live-meta">
      <span>${job.mode === 'repair_existing' ? '기존글 리페어' : '신규 글'}</span>
      <span>${escapeHtml(imageProviderLabel(image, diagnostics))}</span>
      <span>${escapeHtml(imageProgressLabel(image))}</span>
      ${backlog > 1 ? `<span>전체 ${backlog}건 처리 필요</span>` : ''}
    </div>
    ${progressHtml({ ...job, status: 'ready' })}
    <p class="live-note">KIE 우선 · 이미지 1장씩 처리 · 같은 글은 즉시 계속 · 다음 글은 10초 후</p>
  </div>`;
}

function syncQueueSummary(jobs, diagnostics, image) {
  const summary = document.querySelector('#queue-summary');
  if (!summary) return;
  const counts = jobs.reduce((acc, job) => {
    const status = String(job.status || 'unknown');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const contentActive = [...ACTIVE_ALL].reduce((sum, key) => sum + Number(counts[key] || 0), 0);
  const imageBacklog = Number(diagnostics?.totals?.readyMissingImages || 0);
  const active = contentActive + (image ? 1 : 0);
  summary.innerHTML = `
    <div><strong>${jobs.length}</strong><span>최근 작업</span></div>
    <div><strong>${counts.queued || 0}</strong><span>대기</span></div>
    <div><strong>${active}</strong><span>진행 중</span></div>
    <div><strong>${imageBacklog}</strong><span>이미지 대기</span></div>
  `;
}

function render(jobs, diagnostics = lastImageDiagnostics) {
  if (!host) return;
  const active = currentJob(jobs);
  const image = currentImageWork(jobs, diagnostics);
  const queue = queueCandidates(jobs);
  const retryCount = jobs.filter((job) => String(job.recovery_state || '') === 'retry_wait' && !PROTECTED.has(Number(job.id))).length;
  const imageBacklog = Number(diagnostics?.totals?.readyMissingImages || 0);

  syncQueueSummary(jobs, diagnostics, image);
  const pill = host.closest('.live-work-panel')?.querySelector('.status-pill');
  if (pill) pill.textContent = `${active ? '글 1' : '글 0'} · 이미지 ${imageBacklog}`;

  const queueHtml = queue.length ? `
    <div class="live-queue-head"><strong>글 순차 처리 대기</strong><span>${queue.length}건${retryCount ? ` · 재시도 ${retryCount}건` : ''}</span></div>
    <div class="live-next-list">${queue.slice(0, 5).map((job, index) => `
      <div class="live-next-row">
        <span class="live-order">${index + 1}</span>
        <div><strong>#${Number(job.id)} · ${escapeHtml(shortSubject(job))}</strong><small>${job.mode === 'repair_existing' ? '리페어' : '신규'} · ${String(job.recovery_state || '') === 'retry_wait' ? `재시도 ${escapeHtml(formatTime(job.next_retry_at))} 이후` : '실행 대기'}</small></div>
      </div>`).join('')}</div>
    ${queue.length > 5 ? `<p class="live-more">외 ${queue.length - 5}건 대기 중</p>` : ''}` : '';

  host.innerHTML = `<div class="live-lanes">${renderContentLane(active)}${renderImageLane(image, diagnostics)}</div>${queueHtml}`;
}

function renderDisconnected() {
  if (!host) return;
  host.innerHTML = '<p class="live-muted">관리 연결 후 실시간 작업 진행을 표시합니다.</p>';
}

async function fetchJobs() {
  const data = await adminApi('/api/jobs?limit=100');
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

async function fetchImageDiagnostics() {
  return adminApi(`/api/operations/images/diagnostics?ts=${Date.now()}`);
}

async function fetchDashboard() {
  const [jobs, diagnostics] = await Promise.all([
    fetchJobs(),
    fetchImageDiagnostics().catch(() => null)
  ]);
  return { jobs, diagnostics };
}

async function refresh() {
  if (!host || !isAdminConnected() || document.hidden) {
    if (!isAdminConnected()) renderDisconnected();
    return [];
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchDashboard()
    .then(({ jobs, diagnostics }) => {
      if (diagnostics) lastImageDiagnostics = diagnostics;
      render(jobs, diagnostics || lastImageDiagnostics);
      return jobs;
    })
    .catch(() => [])
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function notify(message, tone = 'normal') {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

async function waitUntilLaneFree(excludeJobId = null) {
  const started = Date.now();
  while (Date.now() - started < MANUAL_MAX_WAIT_MS) {
    const jobs = await fetchJobs();
    render(jobs, lastImageDiagnostics);
    const busy = jobs.find((job) => ACTIVE_AI.has(String(job.status || '')) && Number(job.id) !== Number(excludeJobId));
    if (!busy) return true;
    await sleep(MANUAL_WAIT_MS);
  }
  throw new Error('SERIAL_QUEUE_WAIT_TIMEOUT');
}

async function waitUntilJobStops(jobId) {
  const started = Date.now();
  while (Date.now() - started < MANUAL_MAX_WAIT_MS) {
    await sleep(MANUAL_WAIT_MS);
    const jobs = await fetchJobs();
    render(jobs, lastImageDiagnostics);
    const job = jobs.find((row) => Number(row.id) === Number(jobId));
    if (!job || !ACTIVE_AI.has(String(job.status || ''))) return job || null;
  }
  throw new Error('SERIAL_JOB_WAIT_TIMEOUT');
}

async function startWhenFree(jobId) {
  const started = Date.now();
  while (Date.now() - started < MANUAL_MAX_WAIT_MS) {
    await waitUntilLaneFree(jobId);
    try {
      return await adminApi(`/api/jobs/${jobId}/run`, { method: 'POST', body: '{}' });
    } catch (error) {
      const code = String(error?.message || '').toUpperCase();
      if (error?.status === 409 || code.includes('ALREADY_CLAIMED') || code.includes('NOT_RUNNABLE')) {
        const jobs = await fetchJobs();
        const row = jobs.find((job) => Number(job.id) === Number(jobId));
        if (row && ACTIVE_AI.has(String(row.status || ''))) return { accepted: true, alreadyStarted: true };
        await sleep(MANUAL_WAIT_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error('SERIAL_START_TIMEOUT');
}

async function processManualItem(item) {
  const { jobId, kind } = item;
  if (PROTECTED.has(jobId)) throw new Error(`PROTECTED_JOB_${jobId}`);
  let jobs = await fetchJobs();
  let row = jobs.find((job) => Number(job.id) === jobId);
  if (!row) throw new Error('JOB_NOT_FOUND');

  if (kind === 'retry' && ['failed', 'needs_review'].includes(String(row.status || ''))) {
    await adminApi(`/api/jobs/${jobId}/retry`, { method: 'POST', body: '{}' });
    jobs = await fetchJobs();
    row = jobs.find((job) => Number(job.id) === jobId) || row;
  }
  if (String(row.status || '') !== 'queued') {
    if (ACTIVE_AI.has(String(row.status || ''))) return waitUntilJobStops(jobId);
    throw new Error(`JOB_NOT_RUNNABLE_${String(row.status || 'unknown').toUpperCase()}`);
  }

  await startWhenFree(jobId);
  window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId } }));
  await refresh();
  return waitUntilJobStops(jobId);
}

async function drainManualQueue() {
  if (manualDraining) return;
  manualDraining = true;
  try {
    while (manualQueue.length) {
      const item = manualQueue[0];
      notify(`작업 #${item.jobId} · 순차 처리 ${item.positionLabel}`);
      try {
        await processManualItem(item);
        notify(`작업 #${item.jobId} 처리 후 다음 순서로 넘어갑니다.`);
      } catch (error) {
        notify(`작업 #${item.jobId}: ${error.message}`, 'danger');
      }
      manualQueue.shift();
      manualQueue.forEach((queued, index) => { queued.positionLabel = `${index + 1}번 대기`; });
      window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId: item.jobId } }));
      await refresh();
    }
  } finally {
    manualDraining = false;
  }
}

function enqueueManual(jobId, kind) {
  if (PROTECTED.has(jobId)) return notify(`#${jobId}은 보호 작업이라 실행하지 않습니다.`, 'danger');
  if (manualQueue.some((item) => item.jobId === jobId)) return notify(`#${jobId}은 이미 순차 처리 대기열에 있습니다.`);
  manualQueue.push({ jobId, kind, positionLabel: `${manualQueue.length + 1}번 대기` });
  notify(`#${jobId}을 순차 처리 대기열 ${manualQueue.length}번에 넣었습니다.`);
  void drainManualQueue();
}

function interceptManualRun(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = String(button.dataset.action || '');
  if (!['retry-readable', 'run'].includes(action)) return;
  const jobId = Number(button.dataset.jobId);
  if (!Number.isInteger(jobId)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  enqueueManual(jobId, action === 'retry-readable' ? 'retry' : 'run');
}

function installStyle() {
  if (document.querySelector('#live-work-progress-style')) return;
  const style = document.createElement('style');
  style.id = 'live-work-progress-style';
  style.textContent = `
    .live-work-panel{border-color:#29405f;background:linear-gradient(150deg,#0b1423,#0a101b)}
    .live-work-panel .panel-head{margin-bottom:12px}.live-lanes{display:grid;gap:9px}.live-lane-card{display:grid;gap:9px;padding:11px;border:1px solid #1d3049;border-radius:13px;background:#09111e}.live-lane-card.idle{gap:4px;background:#09101b}.live-lane-card.image-lane{border-color:#263c5c}.live-lane-head,.live-queue-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.live-lane-head>div{display:flex;align-items:center;gap:8px}.live-lane-state{font-size:10px;font-weight:800;color:#bfdbfe;background:#102340;border:1px solid #24466f;padding:5px 8px;border-radius:999px}.live-lane-state.image{color:#d8b4fe;background:#24133b;border-color:#573076}.live-lane-state.neutral{color:#94a3b8;background:#111827;border-color:#263244}.live-pulse{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.12);animation:livePulse 1.8s ease-in-out infinite}.live-pulse.image{background:#a855f7;box-shadow:0 0 0 4px rgba(168,85,247,.12)}.live-subject{display:flex;gap:9px;align-items:flex-start;min-width:0}.live-subject>span{flex:0 0 auto;color:#93c5fd;font-weight:900}.live-subject b{font-size:14px;line-height:1.4;word-break:break-word}.live-meta{display:flex;flex-wrap:wrap;gap:5px 10px;color:#8395b2;font-size:10px}.live-stage-track{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;padding-top:2px;overflow-x:auto}.live-stage{display:grid;justify-items:center;align-content:start;gap:4px;min-width:58px;text-align:center;color:#64748b}.live-stage-dot{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;border:1px solid #334155;background:#0b1220;font-size:9px;font-weight:900}.live-stage small{font-size:8px;line-height:1.2}.live-stage.done{color:#86efac}.live-stage.done .live-stage-dot{border-color:#166534;background:#052e16;color:#86efac}.live-stage.active{color:#bfdbfe}.live-stage.active .live-stage-dot{border-color:#3b82f6;background:#172554;color:#dbeafe;box-shadow:0 0 0 3px rgba(59,130,246,.12)}.live-note,.live-more,.live-muted{margin:0;color:#71829e;font-size:10px;line-height:1.45}.live-queue-head{padding-top:12px;margin-top:10px;border-top:1px solid #1e2d42}.live-queue-head span{font-size:10px;color:#8ca0bd}.live-next-list{display:grid;gap:6px;margin-top:8px}.live-next-row{display:grid;grid-template-columns:26px minmax(0,1fr);gap:8px;align-items:center;padding:7px 8px;border:1px solid #1d2d43;border-radius:10px;background:#09111e}.live-order{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#111f34;color:#93c5fd;font-size:10px;font-weight:900}.live-next-row div{display:grid;gap:2px;min-width:0}.live-next-row strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.live-next-row small{font-size:9px;color:#71829e}.live-more{margin-top:6px;text-align:right}@keyframes livePulse{0%,100%{opacity:1}50%{opacity:.45}}@media(prefers-reduced-motion:reduce){.live-pulse{animation:none}}@media(max-width:560px){.live-stage-track{grid-template-columns:repeat(7,62px);padding-bottom:3px}.live-lane-head{align-items:flex-start}.live-lane-state{max-width:52%;text-align:right}.live-subject b{font-size:13px}}
  `;
  document.head.appendChild(style);
}

function installHost() {
  if (host) return host;
  const queueSummary = document.querySelector('#queue-summary');
  const queuePanel = queueSummary?.closest('.panel');
  if (!queuePanel) return null;
  const panel = document.createElement('section');
  panel.className = 'panel live-work-panel';
  panel.innerHTML = '<div class="panel-head"><div><p class="section-kicker">LIVE PIPELINE</p><h2>실시간 작업 진행</h2></div><span class="status-pill active">자동 순차 처리</span></div><div id="live-work-progress" aria-live="polite"><p class="live-muted">작업 상태를 불러오는 중입니다.</p></div>';
  queuePanel.parentNode.insertBefore(panel, queuePanel);
  host = panel.querySelector('#live-work-progress');
  return host;
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => void refresh(), POLL_MS);
}

installStyle();
installHost();
document.addEventListener('click', interceptManualRun, true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
window.addEventListener('focus', () => void refresh());
window.addEventListener('orchestrator:jobs-changed', () => void refresh());
schedulePoll();
void refresh();