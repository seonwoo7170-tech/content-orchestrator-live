import { adminApi, isAdminConnected } from './admin-session.js';

const planButton = document.querySelector('#plan-today');
const refreshButton = document.querySelector('#refresh-plan');
const planState = document.querySelector('#plan-state');
const planSummary = document.querySelector('#plan-summary');
const planList = document.querySelector('#plan-list');
let languageByBlog = {};
let diagnosticByBlog = {};
let workloadByBlog = {};
let selectedBlogId = null;
let lastPlanData = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setState(message, tone = 'neutral') {
  if (!planState) return;
  planState.textContent = message;
  planState.className = `status-pill ${tone}`;
}

function slotLabel(kind) {
  return kind === 'repair_existing' ? '기존글 리페어' : '신규 글';
}

function languageLabel(language) {
  return language === 'en' ? 'English' : '한국어';
}

function diagnosticLabel(value) {
  if (value === 'attention') return '주의';
  if (value === 'active') return '작업 중';
  if (value === 'paused') return '중지';
  if (value === 'new') return '신규';
  return '정상';
}

function workloadLabel(value) {
  if (value === 'held') return '보류 우선';
  if (value === 'review') return '검수 우선';
  if (value === 'retry_wait') return '재시도 우선';
  if (value === 'backlog') return '백로그 정리';
  if (value === 'bootstrap') return '초기 성장';
  if (value === 'growth_bootstrap') return '성장 우선';
  if (value === 'growth') return '성장';
  if (value === 'recovery') return '리페어 우선';
  if (value === 'validation') return '검증';
  if (value === 'paused') return '중지';
  return '자동';
}

function formatRecoveryTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function slotRecoveryNote(slot) {
  if (slot.recovery_state === 'held') {
    return `<span class="status-pill danger">보류 · ${escapeHtml(slot.hold_reason || slot.last_error_code || '확인 필요')}</span>`;
  }
  if (slot.recovery_state === 'retry_wait') {
    const due = formatRecoveryTime(slot.next_retry_at);
    return `<span class="status-pill active">재시도 대기${due ? ` · ${escapeHtml(due)}` : ''}</span>`;
  }
  return '';
}

function renderPendingSlot(slot) {
  const recoveryNote = slotRecoveryNote(slot);
  if (slot.kind === 'repair_existing') {
    return `
      <form class="plan-slot-form" data-slot-id="${slot.id}" data-slot-kind="repair_existing">
        <div class="slot-form-head"><strong>${escapeHtml(slotLabel(slot.kind))}</strong><span>대상 지정</span></div>
        ${recoveryNote}
        <label>Post ID<input name="bloggerPostId" required inputmode="numeric" placeholder="기존 Blogger Post ID"></label>
        <label>게시물 URL<input name="targetUrl" type="url" placeholder="선택 입력"></label>
        <label>추가 지시<input name="instructions" placeholder="선택 입력"></label>
        <button class="button small" type="submit">리페어 작업 연결</button>
      </form>`;
  }

  const resolvedLanguage = languageByBlog[String(slot.blog_id)] || 'ko';
  return `
    <form class="plan-slot-form" data-slot-id="${slot.id}" data-slot-kind="new_article">
      <div class="slot-form-head"><strong>${escapeHtml(slotLabel(slot.kind))}</strong><span>주제 지정</span></div>
      ${recoveryNote}
      <label>주제<input name="topic" required placeholder="오늘 작성할 주제"></label>
      <label>언어<select name="language">
        <option value="auto" selected>블로그 설정 사용 · ${escapeHtml(languageLabel(resolvedLanguage))}</option>
        <option value="ko">한국어로 직접 지정</option>
        <option value="en">English 직접 지정</option>
      </select></label>
      <button class="button small primary" type="submit">신규 작업 연결</button>
    </form>`;
}

function renderSlot(slot) {
  if (slot.status === 'resolved' && slot.job_id) {
    return `
      <div class="plan-slot resolved">
        <span>${escapeHtml(slotLabel(slot.kind))}</span>
        <strong>Job #${escapeHtml(slot.job_id)}</strong>
      </div>`;
  }
  if (slot.status === 'skipped') {
    return `
      <div class="plan-slot skipped">
        <span>${escapeHtml(slotLabel(slot.kind))}</span>
        <strong>건너뜀</strong>
      </div>`;
  }
  return renderPendingSlot(slot);
}

function groupSlots(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = String(slot.blog_id);
    if (!groups.has(key)) groups.set(key, { name: slot.blog_name || `Blog ${key}`, id: key, slots: [] });
    groups.get(key).slots.push(slot);
  }
  return groups;
}

function renderSelectedBlog(groups) {
  if (!groups.size) return '';
  if (!selectedBlogId || !groups.has(String(selectedBlogId))) selectedBlogId = groups.keys().next().value;
  const group = groups.get(String(selectedBlogId));
  const groupResolved = group.slots.filter((slot) => slot.status === 'resolved').length;
  const language = languageByBlog[String(group.id)] || 'ko';
  const diagnostic = diagnosticByBlog[String(group.id)] || null;
  const workload = workloadByBlog[String(group.id)] || null;
  const options = [...groups.values()].map((candidate) => `
    <option value="${escapeHtml(candidate.id)}" ${String(candidate.id) === String(group.id) ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`).join('');
  const workloadText = workload
    ? ` · 우선순위 ${escapeHtml(workload.priorityScore)} (${escapeHtml(workloadLabel(workload.priorityLabel))}) · 신규 ${escapeHtml(workload.newArticles)} / 리페어 ${escapeHtml(workload.repairs)}`
    : '';

  return `
    <article class="plan-blog plan-blog-single">
      <div class="plan-blog-head">
        <div class="plan-blog-identity">
          <div class="plan-blog-picker">
            <select id="plan-blog-select" aria-label="작업 대상 블로그">${options}</select>
            <span aria-hidden="true">⌄</span>
          </div>
          <small>${escapeHtml(group.id)} · ${escapeHtml(languageLabel(language))}${workloadText}</small>
        </div>
        <span class="status-pill ${diagnostic?.severity === 'attention' ? 'danger' : groupResolved === group.slots.length ? 'success' : 'neutral'}">${groupResolved}/${group.slots.length} 연결 · ${escapeHtml(diagnosticLabel(diagnostic?.severity))}</span>
      </div>
      <div class="plan-slots">${group.slots.map(renderSlot).join('')}</div>
    </article>`;
}

function recoveryCounts(recovery) {
  return {
    retryWait: Number(recovery?.summary?.jobs?.retryWait || 0) + Number(recovery?.summary?.slots?.retryWait || 0),
    held: Number(recovery?.summary?.jobs?.held || 0) + Number(recovery?.summary?.slots?.held || 0)
  };
}

function render(data) {
  lastPlanData = data;
  const slots = Array.isArray(data?.slots) ? data.slots : [];
  languageByBlog = data?.languages && typeof data.languages === 'object' ? data.languages : {};
  diagnosticByBlog = Object.fromEntries((Array.isArray(data?.diagnostics) ? data.diagnostics : []).map((item) => [String(item.blogId), item]));
  workloadByBlog = Object.fromEntries((Array.isArray(data?.workload?.decisions) ? data.workload.decisions : []).map((item) => [String(item.blogId), item]));
  const groups = groupSlots(slots);
  const newCount = slots.filter((slot) => slot.kind === 'new_article' && slot.status !== 'skipped').length;
  const repairCount = slots.filter((slot) => slot.kind === 'repair_existing' && slot.status !== 'skipped').length;
  const resolvedCount = slots.filter((slot) => slot.status === 'resolved').length;
  const attentionCount = Array.isArray(data?.diagnostics) ? data.diagnostics.filter((item) => item.severity === 'attention').length : 0;
  const recovery = recoveryCounts(data?.recovery);
  planSummary.innerHTML = `
    <div><strong>${escapeHtml(data?.planDate || '-')}</strong><span>운영일</span></div>
    <div><strong>${Object.keys(workloadByBlog).length || groups.size}</strong><span>블로그</span></div>
    <div><strong>${newCount}</strong><span>자동 신규</span></div>
    <div><strong>${repairCount}</strong><span>자동 리페어</span></div>
    <div><strong>${attentionCount}</strong><span>주의</span></div>
    <div><strong>${recovery.retryWait}</strong><span>재시도 대기</span></div>
    <div><strong>${recovery.held}</strong><span>보류</span></div>
  `;

  if (!slots.length) {
    planList.innerHTML = '<p class="muted">오늘 계획이 아직 없습니다. 계획 생성은 AI 호출이나 Blogger 변경을 하지 않습니다.</p>';
    setState('계획 없음');
    return;
  }

  planList.innerHTML = renderSelectedBlog(groups);
  const recoveryText = recovery.retryWait || recovery.held ? ` · 재시도 ${recovery.retryWait} · 보류 ${recovery.held}` : '';
  setState(`${resolvedCount}/${slots.length} 작업 연결${recoveryText}`, recovery.held > 0 ? 'danger' : resolvedCount === slots.length ? 'success' : 'active');
}

async function loadRecovery() {
  try {
    return await adminApi('/api/operations/recovery');
  } catch {
    return null;
  }
}

export async function loadPlan() {
  if (!isAdminConnected()) {
    setState('관리 연결 필요');
    planSummary.innerHTML = '';
    planList.innerHTML = '<p class="muted">관리 연결 후 오늘 운영 계획을 확인합니다.</p>';
    return;
  }
  setState('불러오는 중', 'active');
  try {
    const [plan, recovery] = await Promise.all([adminApi('/api/operations/today'), loadRecovery()]);
    render({ ...plan, recovery });
  } catch (error) {
    setState('조회 실패', 'danger');
    planList.innerHTML = `<p class="job-error">오늘 계획 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

planButton?.addEventListener('click', async () => {
  planButton.disabled = true;
  setState('계획 생성 중', 'active');
  try {
    const [data, recovery] = await Promise.all([
      adminApi('/api/operations/plan-today', { method: 'POST', body: '{}' }),
      loadRecovery()
    ]);
    render({ ...data, recovery });
  } catch (error) {
    setState('생성 실패', 'danger');
    planList.innerHTML = `<p class="job-error">계획 생성 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    planButton.disabled = false;
  }
});

planList?.addEventListener('change', (event) => {
  const picker = event.target.closest('#plan-blog-select');
  if (!picker || !lastPlanData) return;
  selectedBlogId = String(picker.value);
  render(lastPlanData);
});

planList?.addEventListener('submit', async (event) => {
  const form = event.target.closest('.plan-slot-form');
  if (!form) return;
  event.preventDefault();
  const slotId = Number(form.dataset.slotId);
  if (!Number.isInteger(slotId) || slotId <= 0) return;

  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  const payload = form.dataset.slotKind === 'repair_existing'
    ? {
        bloggerPostId: values.get('bloggerPostId'),
        targetUrl: values.get('targetUrl'),
        instructions: values.get('instructions')
      }
    : {
        topic: values.get('topic'),
        language: values.get('language') || 'auto'
      };

  button.disabled = true;
  setState(`슬롯 #${slotId} 연결 중`, 'active');
  try {
    const data = await adminApi(`/api/operations/slots/${slotId}/materialize`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setState(`Job #${data.jobId} 연결됨`, 'success');
    window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId: data.jobId } }));
    await loadPlan();
  } catch {
    setState('작업 연결 실패', 'danger');
    button.disabled = false;
    button.textContent = '다시 시도';
  }
});

refreshButton?.addEventListener('click', loadPlan);
window.addEventListener('orchestrator:admin-session', loadPlan);
loadPlan();
