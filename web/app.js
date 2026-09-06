import {
  adminApi,
  adminSessionReady,
  connectAdmin,
  disconnectAdmin,
  isAdminConnected
} from './admin-session.js';

const phaseItems = document.querySelector('#phase-items');
const phaseCount = document.querySelector('#phase-count');
const phaseBar = document.querySelector('#phase-bar');
const writeState = document.querySelector('#write-state');
const adminInput = document.querySelector('#admin-key');
const adminState = document.querySelector('#admin-state');
const topAdminState = document.querySelector('#top-admin-state');
const saveAdminButton = document.querySelector('#save-admin-key');
const clearAdminButton = document.querySelector('#clear-admin-key');
const refreshJobsButton = document.querySelector('#refresh-jobs');
const diagnoseAiButton = document.querySelector('#diagnose-ai');
const newJobForm = document.querySelector('#new-job-form');
const repairJobForm = document.querySelector('#repair-job-form');
const jobList = document.querySelector('#job-list');
const queueSummary = document.querySelector('#queue-summary');
const toast = document.querySelector('#toast');
const appViews = [...document.querySelectorAll('[data-view]')];
const navButtons = [...document.querySelectorAll('[data-nav-target]')];
const homeQueued = document.querySelector('#home-queued');
const homeActive = document.querySelector('#home-active');
const homeReady = document.querySelector('#home-ready');
const homeBlogs = document.querySelector('#home-blogs');
const VIEW_STORAGE = 'content-orchestrator-last-view';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setAdminVisualState() {
  const connected = isAdminConnected();
  if (adminState) {
    adminState.textContent = connected ? '연결됨' : '미연결';
    adminState.className = `status-pill ${connected ? 'success' : 'neutral'}`;
  }
  if (topAdminState) topAdminState.textContent = connected ? '관리 연결됨' : '관리 연결';
  document.body.dataset.adminConnected = String(connected);
  if (connected && adminInput) adminInput.value = '';
}

function showToast(message, tone = 'normal') {
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function readResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function publicApi(path) {
  return readResponse(await fetch(path, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin'
  }));
}

function statusLabel(status) {
  const labels = {
    queued: '대기',
    writing: '작성 중',
    critic_review: '딴지 검수',
    repairing: '리페어',
    final_critic: '최종 딴지',
    ready: '승인/발행 준비',
    updating_existing: '기존글 업데이트',
    publishing_new: '신규 발행',
    completed: '완료',
    needs_review: '확인 필요',
    failed: '실패'
  };
  return labels[status] || status || '알 수 없음';
}

function statusTone(status) {
  if (['completed', 'ready'].includes(status)) return 'success';
  if (['failed', 'needs_review'].includes(status)) return 'danger';
  if (['writing', 'critic_review', 'repairing', 'final_critic', 'updating_existing', 'publishing_new'].includes(status)) return 'active';
  return 'neutral';
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value.endsWith?.('Z') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function openView(name, options = {}) {
  const target = appViews.find((view) => view.dataset.view === name) || appViews[0];
  if (!target) return;
  for (const view of appViews) view.hidden = view !== target;
  for (const button of navButtons) button.classList.toggle('active', button.dataset.navTarget === target.dataset.view);
  try { localStorage.setItem(VIEW_STORAGE, target.dataset.view); } catch { /* ignore */ }
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: options.smooth ? 'smooth' : 'auto' });
}

async function loadPublicState() {
  try {
    const [phase, health] = await Promise.all([publicApi('/api/phase1'), publicApi('/health')]);
    if (phaseCount) phaseCount.textContent = `${phase.completed} / ${phase.total}`;
    if (phaseBar) phaseBar.style.width = `${phase.percent}%`;
    if (phaseItems) {
      phaseItems.innerHTML = phase.items.map((item) => `
        <div class="phase-row ${item.verified ? 'done' : ''}">
          <span class="dot"></span><span>${escapeHtml(item.label)}</span>
        </div>`).join('');
    }
    if (writeState) {
      writeState.textContent = health.bloggerWritesEnabled ? 'ON' : 'OFF';
      writeState.dataset.enabled = String(Boolean(health.bloggerWritesEnabled));
    }
  } catch {
    if (phaseItems) phaseItems.innerHTML = '<p class="muted">API 배포 상태를 확인할 수 없습니다.</p>';
    if (writeState) writeState.textContent = 'OFF';
  }
}

function renderQueueSummary(jobs) {
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  const active = ['writing', 'critic_review', 'repairing', 'final_critic'].reduce((sum, key) => sum + (counts[key] || 0), 0);
  const ready = (counts.ready || 0) + (counts.needs_review || 0);
  if (queueSummary) {
    queueSummary.innerHTML = `
      <div><strong>${jobs.length}</strong><span>최근 작업</span></div>
      <div><strong>${counts.queued || 0}</strong><span>대기</span></div>
      <div><strong>${active}</strong><span>진행 중</span></div>
      <div><strong>${ready + (counts.completed || 0)}</strong><span>준비/완료</span></div>
    `;
  }
  if (homeQueued) homeQueued.textContent = counts.queued || 0;
  if (homeActive) homeActive.textContent = active;
  if (homeReady) homeReady.textContent = ready;
}

function renderJobs(jobs) {
  renderQueueSummary(jobs);
  if (!jobList) return;
  if (!jobs.length) {
    jobList.innerHTML = '<p class="muted">아직 생성된 작업이 없습니다.</p>';
    return;
  }

  jobList.innerHTML = jobs.map((job) => {
    const modeLabel = job.mode === 'repair_existing' ? '기존글 리페어' : '신규 글';
    const subject = job.topic || job.target_url || `Post ${job.blogger_post_id || ''}`;
    const error = job.error ? `<p class="job-error">${escapeHtml(job.error)}</p>` : '';
    const runButton = job.status === 'queued'
      ? `<button class="button small" data-action="run" data-job-id="${job.id}" type="button">실행</button>`
      : '';
    const detailButton = job.has_result || job.has_error
      ? `<button class="button small ghost" data-action="detail" data-job-id="${job.id}" type="button">결과</button>`
      : '';

    return `
      <article class="job-row" data-job="${job.id}">
        <div class="job-topline">
          <div><span class="job-id">#${job.id}</span><span class="mode-badge">${modeLabel}</span></div>
          <span class="status-pill ${statusTone(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
        </div>
        <h3>${escapeHtml(subject)}</h3>
        <div class="job-meta">
          <span>Blog ${escapeHtml(job.blog_id || '-')}</span>
          ${job.blogger_post_id ? `<span>Post ${escapeHtml(job.blogger_post_id)}</span>` : ''}
          <span>${escapeHtml(formatTime(job.updated_at || job.created_at))}</span>
        </div>
        ${error}
        <div class="job-actions">${runButton}${detailButton}</div>
        <pre class="job-details" data-details-for="${job.id}" hidden></pre>
      </article>`;
  }).join('');
}

export async function loadJobs() {
  if (!isAdminConnected()) {
    if (jobList) jobList.innerHTML = '<p class="muted">관리 연결 후 작업 큐를 불러옵니다.</p>';
    if (queueSummary) queueSummary.innerHTML = '';
    renderQueueSummary([]);
    return;
  }
  if (jobList) jobList.innerHTML = '<p class="muted">작업 큐를 불러오는 중입니다.</p>';
  try {
    const data = await adminApi('/api/jobs?limit=50');
    renderJobs(data.jobs || []);
  } catch (error) {
    if (error.status === 401) showToast('관리 연결이 만료되었습니다.', 'danger');
    if (jobList) jobList.innerHTML = `<p class="job-error">작업 큐 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

async function submitJson(path, payload) {
  return adminApi(path, { method: 'POST', body: JSON.stringify(payload) });
}

saveAdminButton?.addEventListener('click', async () => {
  const key = adminInput?.value.trim() || '';
  if (!key) return showToast('관리 키를 입력해 주세요.', 'danger');
  saveAdminButton.disabled = true;
  try {
    await connectAdmin(key);
    if (adminInput) adminInput.value = '';
    setAdminVisualState();
    showToast('관리 연결을 저장했습니다. 이 기기에서 최대 30일 유지됩니다.');
    openView('home');
  } catch (error) {
    showToast(`관리 연결 실패: ${error.message}`, 'danger');
  } finally {
    saveAdminButton.disabled = false;
  }
});

clearAdminButton?.addEventListener('click', async () => {
  clearAdminButton.disabled = true;
  try {
    await disconnectAdmin();
    if (adminInput) adminInput.value = '';
    setAdminVisualState();
    showToast('관리 연결을 해제했습니다.');
  } catch (error) {
    showToast(`연결 해제 실패: ${error.message}`, 'danger');
  } finally {
    clearAdminButton.disabled = false;
  }
});

refreshJobsButton?.addEventListener('click', loadJobs);

diagnoseAiButton?.addEventListener('click', async () => {
  diagnoseAiButton.disabled = true;
  try {
    const result = await submitJson('/api/diagnostics/cloudflare-ai', {});
    showToast(result.ok ? 'Workers AI 연결이 정상입니다.' : 'Workers AI 연결을 확인해 주세요.', result.ok ? 'normal' : 'danger');
  } catch (error) {
    showToast(`AI 연결 확인 실패: ${error.message}`, 'danger');
  } finally {
    diagnoseAiButton.disabled = false;
  }
});

newJobForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(newJobForm);
  try {
    const data = await submitJson('/api/jobs/new', {
      blogId: form.get('blogId'),
      topic: form.get('topic'),
      language: form.get('language') || 'auto'
    });
    const language = data?.job?.language === 'en' ? 'English' : '한국어';
    showToast(`신규 글 #${data.jobId} · ${language}로 큐에 추가했습니다.`);
    newJobForm.reset();
    await loadJobs();
    openView('work');
  } catch (error) {
    showToast(`작업 등록 실패: ${error.message}`, 'danger');
  }
});

repairJobForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(repairJobForm);
  try {
    const data = await submitJson('/api/jobs/repair-existing', {
      blogId: form.get('blogId'),
      bloggerPostId: form.get('bloggerPostId'),
      targetUrl: form.get('targetUrl'),
      instructions: form.get('instructions')
    });
    showToast(`기존글 리페어 #${data.jobId}을 큐에 추가했습니다.`);
    repairJobForm.reset();
    await loadJobs();
    openView('work');
  } catch (error) {
    showToast(`리페어 등록 실패: ${error.message}`, 'danger');
  }
});

jobList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const jobId = Number(button.dataset.jobId);
  if (!Number.isInteger(jobId)) return;

  if (button.dataset.action === 'run') {
    button.disabled = true;
    button.textContent = '실행 중';
    try {
      const data = await submitJson(`/api/jobs/${jobId}/run`, {});
      showToast(`작업 #${jobId}: ${statusLabel(data.state)}`);
      await loadJobs();
    } catch (error) {
      showToast(`작업 실행 실패: ${error.message}`, 'danger');
      await loadJobs();
    }
    return;
  }

  if (button.dataset.action === 'detail') {
    const target = jobList.querySelector(`[data-details-for="${jobId}"]`);
    if (!target) return;
    if (!target.hidden) {
      target.hidden = true;
      return;
    }
    button.disabled = true;
    try {
      const data = await adminApi(`/api/jobs/${jobId}`);
      const row = data.job || {};
      let result = row.result_json;
      try { result = result ? JSON.parse(result) : null; } catch { /* keep raw */ }
      target.textContent = JSON.stringify({ status: row.status, result, error: row.error || null }, null, 2);
      target.hidden = false;
    } catch (error) {
      showToast(`결과 조회 실패: ${error.message}`, 'danger');
    } finally {
      button.disabled = false;
    }
  }
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-open-view]');
  if (!target) return;
  const view = target.dataset.openView;
  if (!view) return;
  openView(view, { smooth: false });
  const blogId = target.dataset.blogId;
  if (view === 'automation' && blogId) {
    setTimeout(() => window.dispatchEvent(new CustomEvent('orchestrator:open-blog-automation', { detail: { blogId } })), 30);
  }
});

window.addEventListener('orchestrator:admin-session', async () => {
  setAdminVisualState();
  await loadJobs();
});
window.addEventListener('orchestrator:jobs-changed', loadJobs);
window.addEventListener('orchestrator:blogs-loaded', (event) => {
  if (homeBlogs) homeBlogs.textContent = String(event.detail?.count ?? '-');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

let initialView = 'home';
try { initialView = localStorage.getItem(VIEW_STORAGE) || 'home'; } catch { /* ignore */ }
openView(initialView, { scroll: false });
loadPublicState();
await adminSessionReady;
setAdminVisualState();
loadJobs();
