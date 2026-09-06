import { adminApi, isAdminConnected } from './admin-session.js';

const jobList = document.querySelector('#job-list');
const workView = document.querySelector('[data-view="work"]');
const toast = document.querySelector('#toast');
const refreshJobsButton = document.querySelector('#refresh-jobs');
const trackedTimers = new Map();
let backgroundRefreshRunning = false;

const TRACKABLE_LABELS = new Set([
  '대기', '작성 중', '딴지 검수', '리페어', '최종 딴지',
  '기존글 업데이트', '신규 발행', '확인 필요', '실패',
  '승인/발행 준비', '발행 준비', '작성 완료', '작성 완료 · 이미지 대기',
  '이미지 처리 중', '이미지 확인 필요', '발행 대기', '발행 처리 중'
]);

function workViewVisible() {
  return Boolean(workView && !workView.hidden && !document.hidden);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function notify(message, tone = 'normal') {
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function asUtcDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = asUtcDate(value);
  if (!date) return value ? String(value) : '-';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function parseResult(row) {
  try { return row?.result_json ? JSON.parse(row.result_json) : null; } catch { return null; }
}

function imageProgress(images = []) {
  const rows = Array.isArray(images) ? images : [];
  const done = rows.filter((item) => ['stored', 'attached'].includes(String(item.status))).length;
  const attached = rows.filter((item) => String(item.status) === 'attached').length;
  const failed = rows.filter((item) => String(item.status) === 'failed').length;
  const active = rows.filter((item) => ['planned', 'generating', 'generated'].includes(String(item.status))).length;
  return { total: rows.length, done, attached, failed, active };
}

function recoveryLabel(row) {
  const state = String(row?.recovery_state || 'none');
  if (state === 'retry_wait') return '자동 재시도 대기';
  if (state === 'held') return '자동완료 중단';
  return null;
}

function evidenceProgress(result) {
  const evidence = result?.deliveryEvidence;
  if (!evidence || !Array.isArray(evidence.gates)) return null;
  const required = evidence.gates.filter((item) => item.required !== false);
  const passed = required.filter((item) => item.passed).length;
  const waiting = required.filter((item) => !item.passed).map((item) => item.label || item.id).filter(Boolean);
  return {
    status: evidence.status || (passed === required.length ? 'PASS' : 'INCOMPLETE'),
    passed,
    total: required.length,
    waiting
  };
}

function operationalState(row, result) {
  const status = String(row?.status || '');
  const recovery = String(row?.recovery_state || 'none');
  const code = String(row?.hold_reason || row?.last_error_code || row?.error || '').toUpperCase();
  if (status === 'completed') return { code: 'DONE', label: '완료', tone: 'done' };
  if (recovery === 'held' || code.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN') || code.includes('DUPLICATE_TOPIC_PUBLICATION_BLOCKED')) {
    return { code: 'BLOCKED', label: '자동 처리 차단', tone: 'blocked' };
  }
  if (status === 'needs_review') return { code: 'REVIEW', label: '검토/보완', tone: 'review' };
  if (status === 'failed' && recovery !== 'retry_wait') return { code: 'FAILED', label: '실패', tone: 'failed' };
  if (status === 'failed' && recovery === 'retry_wait') return { code: 'RUNNING', label: '자동 복구 대기', tone: 'running' };
  if (result?.publicationVerification?.status === 'PENDING') return { code: 'RUNNING', label: 'Blogger 확인 중', tone: 'running' };
  return { code: 'RUNNING', label: '자동 처리 중', tone: 'running' };
}

function progressInfo(row, images = []) {
  const status = String(row?.status || '');
  const mode = String(row?.mode || 'new_article');
  const recovery = recoveryLabel(row);
  const image = imageProgress(images);
  const result = parseResult(row);
  const publication = result?.publication || null;
  const verificationPending = result?.publicationVerification?.status === 'PENDING';
  const isRepair = mode === 'repair_existing';
  const flow = isRepair
    ? '원문 확인 → Critic → 부분 Repair → 최종 Critic → 기계 QA → 이미지 보완 → Blogger 업데이트 → Post ID 재확인 → DONE'
    : 'Writer → Critic → 부분 Repair(필요 시) → 최종 Critic → 기계 QA → 이미지 → Blogger 발행 → Post ID 재확인 → DONE';

  if (status === 'queued') return { current: '실행 대기', next: isRepair ? 'Critic 검수 시작' : 'Writer가 초안 작성', tone: 'active', flow };
  if (status === 'writing') return { current: 'Writer가 글을 작성 중', next: '작성 완료 후 Critic 검수', tone: 'active', flow };
  if (status === 'critic_review') return { current: 'Critic이 글을 검수 중', next: 'PASS면 다음 단계 · FAIL이면 문제 부분만 Repair', tone: 'active', flow };
  if (status === 'repairing') return { current: '지적된 부분을 Repair 중', next: '수정 후 다시 Critic 검수', tone: 'active', flow };
  if (status === 'final_critic') return { current: '최종 Critic 검수 중', next: '95점 이상 PASS 후 기계 QA·이미지 처리', tone: 'active', flow };
  if (status === 'updating_existing') {
    if (verificationPending) return { current: 'Blogger 업데이트 저장 완료 · 같은 Post ID 재확인 중', next: '5분 복구기가 기존 Post ID를 다시 읽어 확인한 뒤 DONE 판정', tone: 'active', flow };
    return { current: 'Blogger 기존 글 업데이트 중', next: '저장 후 같은 Post ID 재확인', tone: 'active', flow };
  }
  if (status === 'publishing_new') {
    if (verificationPending) return { current: 'Blogger 저장 완료 · 같은 Post ID 재확인 중', next: '새 글을 다시 만들지 않고 저장된 Post ID만 확인한 뒤 DONE 판정', tone: 'active', flow };
    return { current: 'Blogger 신규 글 발행 중', next: '저장 후 Post ID·URL 재확인', tone: 'active', flow };
  }
  if (status === 'completed') return { current: '모든 필수 Gate 통과 · 작업 완료', next: '활성 작업 목록에서 자동 제거', tone: 'success', flow };

  if (status === 'ready') {
    if (publication?.url) return { current: 'Blogger 결과 확인 단계', next: '완료 Gate와 Post ID 재확인', tone: 'active', flow };
    if (image.failed > 0) return { current: `이미지 오류 ${image.failed}건 · 자동 재시도 대기`, next: '이미지 복구 후 발행 조건 재검사', tone: 'danger', flow };
    if (image.total === 0) return { current: '글 작성·검수 완료 · 이미지 대기', next: '5분 이미지 작업기가 썸네일/본문 이미지 생성', tone: 'active', flow };
    if (image.done < image.total) return { current: `이미지 생성/검수 중 · ${image.done}/${image.total}장 준비`, next: '남은 이미지 생성·QA·저장', tone: 'active', flow };
    return { current: `이미지 준비 완료 · ${image.done}/${image.total}장`, next: isRepair ? '기계 QA 후 Blogger 기존 글 업데이트' : '기계 QA 후 Blogger 발행', tone: 'success', flow };
  }

  if (status === 'needs_review') {
    if (recovery === '자동 재시도 대기') return { current: '검수 보완을 위한 자동 재작성 대기', next: '복구 시각에 같은 Job을 다시 실행', tone: 'active', flow };
    if (recovery === '자동완료 중단') return { current: '자동완료가 안전상 중단됨', next: '아래 중단 사유 확인 필요', tone: 'danger', flow };
    return { current: '검수 결과 보완 필요 · 자동복구 준비', next: '다음 5분 복구 틱에서 재작성', tone: 'active', flow };
  }

  if (status === 'failed') {
    if (recovery === '자동 재시도 대기') return { current: '오류 복구 대기', next: '예약된 시각에 같은 Job 자동 재실행', tone: 'active', flow };
    if (recovery === '자동완료 중단') return { current: '자동완료가 안전상 중단됨', next: '아래 중단 사유를 해결한 뒤 재개', tone: 'danger', flow };
    return { current: '작업 실패 · 자동복구 등록 확인 중', next: '다음 복구 틱에서 재처리 여부 판정', tone: 'danger', flow };
  }

  return { current: status || '상태 확인 중', next: '다음 상태를 확인합니다.', tone: 'active', flow };
}

function reasonText(row) {
  const value = String(row?.hold_reason || row?.last_error_code || row?.error || '').trim();
  if (!value) return null;
  const code = value.toUpperCase();
  if (code.includes('DUPLICATE_TOPIC_PUBLICATION_BLOCKED')) return '중복 글 발행 위험 때문에 자동 재작성하지 않습니다.';
  if (code.includes('BLOGGER_READBACK')) return 'Blogger에는 저장됐지만 Post ID/URL 재확인이 아직 끝나지 않았습니다. 새 글을 만들지 않고 같은 Post ID만 다시 확인합니다.';
  if (code.includes('DELIVERY_EVIDENCE_INCOMPLETE')) return '필수 완료 Gate 중 하나가 통과되지 않아 DONE 처리를 막았습니다.';
  if (code.includes('DETERMINISTIC_QA_BLOCKED')) return '자리표시자·실행형 링크 등 기계적으로 확인 가능한 결함이 남아 발행을 막았습니다.';
  if (code.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN') || code.includes('STALE_PUBLICATION_CLAIM') || code.includes('MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW')) return 'Blogger에 이미 저장됐을 가능성이 있어 중복 발행 방지를 위해 자동 재실행하지 않습니다.';
  if (code.includes('RETRY_LIMIT_REACHED')) return '자동 복구 3회를 모두 사용했습니다. 결과를 확인해야 합니다.';
  if (code.includes('KIE_INSUFFICIENT_CREDITS')) return '이미지 서비스 사용 가능량을 확인해야 합니다.';
  if (code.includes('AUTH') || code.includes('OAUTH') || code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) return '연결 권한을 확인해야 합니다.';
  return value;
}

function installStyles() {
  if (document.querySelector('#work-live-progress-style')) return;
  const style = document.createElement('style');
  style.id = 'work-live-progress-style';
  style.textContent = `
    .job-live-progress{margin:14px 0 4px;padding:14px;border:1px solid rgba(112,145,205,.24);border-radius:14px;background:rgba(8,16,30,.58)}
    .job-live-progress[data-tone="danger"]{border-color:rgba(248,113,113,.35)}
    .job-live-progress[data-tone="success"]{border-color:rgba(74,222,128,.3)}
    .job-live-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px}
    .job-live-head strong{font-size:14px}.job-live-head span{font-size:12px;opacity:.72}
    .job-op-state{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.04em;border:1px solid rgba(148,163,184,.28)}
    .job-op-state[data-state="DONE"]{border-color:rgba(74,222,128,.45)}
    .job-op-state[data-state="BLOCKED"],.job-op-state[data-state="FAILED"]{border-color:rgba(248,113,113,.5)}
    .job-op-state[data-state="REVIEW"]{border-color:rgba(250,204,21,.45)}
    .job-live-current{font-size:14px;font-weight:700;line-height:1.55;margin-bottom:7px}
    .job-live-next{font-size:13px;line-height:1.55;opacity:.82;margin-bottom:10px}
    .job-live-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 12px;font-size:12px;opacity:.78}
    .job-live-gates{margin-top:10px;padding:9px 10px;border-radius:10px;background:rgba(15,23,42,.55);font-size:12px;line-height:1.55}
    .job-live-flow{margin-top:10px;padding-top:10px;border-top:1px solid rgba(112,145,205,.16);font-size:11px;line-height:1.55;opacity:.62}
    .job-live-reason{margin-top:10px;font-size:12px;line-height:1.55;color:#fca5a5}
    @media(max-width:520px){.job-live-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function ensurePanel(card) {
  if (!card) return null;
  let panel = card.querySelector('.job-live-progress');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'job-live-progress';
  panel.hidden = true;
  const actions = card.querySelector('.job-actions');
  if (actions) actions.before(panel);
  else card.appendChild(panel);
  return panel;
}

function stableLiveRow(previous, incoming, jobId) {
  const hasPrevious = previous && typeof previous === 'object' && Object.keys(previous).length > 0;
  const hasIncoming = incoming && typeof incoming === 'object' && Object.keys(incoming).length > 0;
  if (!hasPrevious && !hasIncoming) return null;
  const row = { ...(hasPrevious ? previous : {}), ...(hasIncoming ? incoming : {}) };
  row.id = Number(row.id) || Number(jobId);
  return row;
}

function progressMeta(row, images = []) {
  const status = String(row?.status || '');
  const retryCount = Number(row?.retry_count || 0);
  const recovery = String(row?.recovery_state || 'none');
  const image = imageProgress(images);
  if (status === 'ready') {
    if (image.total === 0) return '<span><strong>이미지</strong> 작업 대기</span>';
    return `<span><strong>이미지</strong> ${escapeHtml(image.done)}/${escapeHtml(image.total)}장${image.failed ? ` · 오류 ${escapeHtml(image.failed)}` : ''}</span>`;
  }
  if (retryCount > 0 || ['failed', 'needs_review'].includes(status) || ['retry_wait', 'held'].includes(recovery)) {
    return `<span><strong>재시도</strong> ${escapeHtml(retryCount)}/${MAX_RETRY_UI}</span>`;
  }
  return '<span><strong>재시도</strong> 없음</span>';
}

function renderPanel(card, row, images = []) {
  const panel = ensurePanel(card);
  if (!panel) return;
  const result = parseResult(row);
  const info = progressInfo(row, images);
  const state = operationalState(row, result);
  const gates = evidenceProgress(result);
  const reason = reasonText(row);
  const subject = row?.topic || row?.target_url || (row?.blogger_post_id ? `Post ${row.blogger_post_id}` : `Job #${row?.id || ''}`);
  const postId = result?.publication?.bloggerPostId || row?.blogger_post_id || null;
  panel.dataset.tone = info.tone;
  panel.innerHTML = `
    <div class="job-live-head"><strong>현재 작업</strong><span class="job-op-state" data-state="${escapeHtml(state.code)}">${escapeHtml(state.code)} · ${escapeHtml(state.label)}</span></div>
    <div class="job-live-current">${escapeHtml(info.current)}</div>
    <div class="job-live-next"><strong>다음:</strong> ${escapeHtml(info.next)}</div>
    <div class="job-live-grid">
      <span><strong>Job</strong> #${escapeHtml(row?.id || '-')}</span>
      <span><strong>대상</strong> ${escapeHtml(subject)}</span>
      ${progressMeta(row, images)}
      <span><strong>Blogger Post ID</strong> ${escapeHtml(postId || '-')}</span>
      <span><strong>마지막 갱신</strong> ${escapeHtml(formatTime(row?.updated_at))}</span>
      ${row?.next_retry_at ? `<span><strong>다음 재시도</strong> ${escapeHtml(formatTime(row.next_retry_at))}</span>` : ''}
    </div>
    ${gates ? `<div class="job-live-gates"><strong>완료 Gate</strong> ${escapeHtml(gates.passed)}/${escapeHtml(gates.total)} · ${escapeHtml(gates.status)}${gates.waiting.length ? `<br><strong>남은 Gate</strong> ${escapeHtml(gates.waiting.join(' · '))}` : ''}</div>` : ''}
    ${reason ? `<div class="job-live-reason"><strong>중단/확인 사유:</strong> ${escapeHtml(reason)}</div>` : ''}
    <div class="job-live-flow"><strong>처리 흐름:</strong> ${escapeHtml(info.flow)}</div>`;
  panel.hidden = false;
}

const MAX_RETRY_UI = 3;

async function loadLiveJob(jobId) {
  const [data, imageData] = await Promise.all([
    adminApi(`/api/jobs/${jobId}`),
    adminApi(`/api/jobs/${jobId}/images`).catch(() => ({ images: [] }))
  ]);
  return { row: data.job || null, images: imageData.images || [] };
}

async function refreshCard(card) {
  if (!card || !isAdminConnected()) return null;
  const jobId = Number(card.dataset.job);
  if (!Number.isInteger(jobId)) return null;
  try {
    const data = await loadLiveJob(jobId);
    const row = stableLiveRow(card._liveJobRow, data.row, jobId);
    if (!row) return null;
    card._liveJobRow = row;
    renderPanel(card, row, data.images);
    if (String(row.status || '') === 'completed') {
      setTimeout(() => refreshJobsButton?.click(), 150);
    }
    return row;
  } catch {
    if (card._liveJobRow) renderPanel(card, card._liveJobRow, []);
    return card._liveJobRow || null;
  }
}

function shouldTrack(card) {
  const label = card?.querySelector('.status-pill')?.textContent?.trim() || '';
  return TRACKABLE_LABELS.has(label) || Boolean(card?.querySelector('.job-live-progress:not([hidden])'));
}

function startFocusedTracking(jobId, card) {
  stopFocusedTracking(jobId);
  const timer = setInterval(() => void refreshCard(card), 1200);
  trackedTimers.set(jobId, timer);
}

function stopFocusedTracking(jobId) {
  const timer = trackedTimers.get(jobId);
  if (timer) clearInterval(timer);
  trackedTimers.delete(jobId);
}

async function runExistingJob(jobId, button, { resetFirst = false } = {}) {
  if (!isAdminConnected()) return notify('관리 연결 후 실행할 수 있습니다.', 'danger');
  const card = jobList?.querySelector(`[data-job="${jobId}"]`);
  if (!card) return;
  button.disabled = true;
  const originalText = button.textContent;
  ensurePanel(card).hidden = false;
  startFocusedTracking(jobId, card);

  try {
    if (resetFirst) {
      button.textContent = '재작성 준비';
      try {
        await adminApi(`/api/jobs/${jobId}/retry`, { method: 'POST', body: '{}' });
      } catch (error) {
        const code = String(error?.message || '').toUpperCase();
        if (code.includes('JOB_RETRY_ALREADY_CLAIMED') || code.includes('JOB_NOT_RETRYABLE')) {
          await refreshCard(card);
          notify(`작업 #${jobId}은 이미 실행 중입니다. 현재 단계를 아래에 표시합니다.`);
          return;
        }
        throw error;
      }
    }

    button.textContent = '진행 상태 표시 중';
    await refreshCard(card);
    await adminApi(`/api/jobs/${jobId}/run`, { method: 'POST', body: '{}' });
    await refreshCard(card);
    notify(`작업 #${jobId}의 글 작성 파이프라인이 끝났습니다. 이미지·발행·완료 Gate는 자동으로 이어집니다.`);
    refreshJobsButton?.click();
  } catch (error) {
    await refreshCard(card);
    const code = String(error?.message || '').toUpperCase();
    if (code.includes('JOB_EXECUTION_ALREADY_CLAIMED')) {
      notify(`작업 #${jobId}은 이미 다른 실행에서 처리 중입니다. 현재 단계를 계속 표시합니다.`);
    } else if (code.includes('MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW')) {
      notify('Blogger 중복 발행 위험 때문에 자동 재실행하지 않았습니다. 카드의 확인 사유를 봐 주세요.', 'danger');
    } else if (code.includes('DUPLICATE_TOPIC_RETRY_NOT_ALLOWED')) {
      notify('중복 주제로 차단된 작업은 같은 주제로 재작성하지 않습니다.', 'danger');
    } else {
      notify(`작업 #${jobId} 실행 중 문제: ${error.message}`, 'danger');
    }
  } finally {
    stopFocusedTracking(jobId);
    button.disabled = false;
    button.textContent = originalText;
    await refreshCard(card);
  }
}

function enhanceTrackableCards() {
  if (!jobList || !isAdminConnected() || !workViewVisible()) return;
  const cards = [...jobList.querySelectorAll('.job-row')].filter(shouldTrack).slice(0, 6);
  for (const card of cards) {
    ensurePanel(card);
    if (card.dataset.liveProgressLoaded !== 'true') {
      card.dataset.liveProgressLoaded = 'true';
      void refreshCard(card);
    }
  }
}

async function refreshTrackableCards() {
  if (backgroundRefreshRunning || !workViewVisible() || !isAdminConnected() || !jobList) return;
  backgroundRefreshRunning = true;
  try {
    const cards = [...jobList.querySelectorAll('.job-row')].filter(shouldTrack).slice(0, 4);
    for (const card of cards) await refreshCard(card);
  } finally {
    backgroundRefreshRunning = false;
  }
}

function refreshWorkViewSoon() {
  setTimeout(() => {
    enhanceTrackableCards();
    void refreshTrackableCards();
  }, 50);
}

installStyles();

jobList?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = String(button.dataset.action || '');
  if (!['run', 'retry-readable'].includes(action)) return;
  const jobId = Number(button.dataset.jobId);
  if (!Number.isInteger(jobId)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void runExistingJob(jobId, button, { resetFirst: action === 'retry-readable' });
}, true);

if (jobList) {
  new MutationObserver(() => enhanceTrackableCards()).observe(jobList, { childList: true });
  enhanceTrackableCards();
}

document.addEventListener('click', (event) => {
  const target = event.target?.closest?.('[data-open-view="work"], [data-nav-target="work"]');
  if (target) refreshWorkViewSoon();
});
window.addEventListener('focus', () => void refreshTrackableCards());
window.addEventListener('orchestrator:jobs-changed', () => void refreshTrackableCards());
setInterval(() => void refreshTrackableCards(), 30000);