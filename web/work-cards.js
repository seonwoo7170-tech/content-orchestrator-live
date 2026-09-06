import './home-live-status.js';
import { adminApi, isAdminConnected } from './admin-session.js';

const jobList = document.querySelector('#job-list');
const toast = document.querySelector('#toast');
let publicationStateByJob = new Map();
let publicationRefreshPromise = null;
let readyRefreshPromise = null;
let publicationBoundaryTimer = null;

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

function parseResult(row) {
  try { return row?.result_json ? JSON.parse(row.result_json) : null; } catch { return null; }
}

function humanStatus(status) {
  const labels = {
    queued: '대기', writing: '작성 중', critic_review: '딴지 검수', repairing: '리페어',
    final_critic: '최종 딴지', ready: '작성 완료', updating_existing: '기존글 업데이트',
    publishing_new: '신규 발행', completed: '완료', needs_review: '확인 필요', failed: '실패'
  };
  return labels[status] || status || '-';
}

function livePublication(jobId) {
  return publicationStateByJob.get(Number(jobId)) || null;
}

function safeImageErrorCode(value) {
  return String(value || '')
    .split(/[:\s]/)[0]
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .slice(0, 80);
}

function imageSummary(row, result) {
  const images = Array.isArray(row?._images) ? row._images : [];
  const meta = result?.imagePipeline || null;
  const attached = images.filter((image) => image.status === 'attached').length;
  const stored = images.filter((image) => ['stored', 'attached'].includes(String(image.status))).length;
  const failedRows = images.filter((image) => image.status === 'failed');
  const providers = [...new Set([
    ...(Array.isArray(meta?.providers) ? meta.providers : []),
    ...images.map((image) => String(image.provider || '').trim()).filter(Boolean)
  ])];
  const target = Number(meta?.targetTotal ?? (images.length || 0));
  const current = Number(meta?.currentCount ?? (meta?.existingBefore || 0) + attached);
  const missing = Math.max(0, target - current);
  const visible = Boolean(meta) || images.length > 0;
  const state = failedRows.length > 0
    ? `오류 ${failedRows.length}건`
    : (target > 0 ? (missing === 0 ? '완료' : `${missing}장 부족`) : (visible ? '확인 중' : '미생성'));
  return {
    visible,
    state,
    target,
    current,
    attached,
    stored,
    failed: failedRows.length,
    providers,
    errorCodes: [...new Set(failedRows.map((image) => safeImageErrorCode(image.error)).filter(Boolean))]
  };
}

function publicationStatusLabel(publication, mode = '') {
  const status = String(publication?.status || '');
  const repair = mode === 'repair_existing' || String(publication?.kind || '') === 'repair_existing';
  if (status === 'updated') return '리페어 완료';
  if (status === 'scheduled_update') return '업데이트 예약';
  if (status === 'verification_pending') return repair ? '업데이트 확인 중' : '발행 확인 중';
  if (status === 'published') return '발행 완료';
  if (status === 'scheduled') return '예약발행 대기';
  if (status === 'claimed') return repair ? '기존글 업데이트 중' : '발행 처리 중';
  return null;
}

function publicationAwareStatus(row) {
  const publication = livePublication(row?.id);
  const result = parseResult(row);
  const image = imageSummary(row, result);
  const publicationLabel = publicationStatusLabel(publication, row?.mode);
  if (publicationLabel) return publicationLabel;

  if (String(row?.status || '') === 'completed') {
    return row?.mode === 'repair_existing' ? '리페어 완료' : '발행 완료';
  }
  if (String(row?.status || '') === 'ready') {
    if (image.failed > 0) return '이미지 확인 필요';
    if (image.visible) {
      if (image.target > 0 && image.current >= image.target && image.attached >= Math.min(image.target, Math.max(1, image.attached))) return '발행 준비 완료';
      return '이미지 처리 중';
    }
    return result?.imagePipeline?.qa === 'passed' ? '발행 준비 완료' : '작성 완료 · 이미지 대기';
  }
  return humanStatus(row?.status);
}

function friendlyError(value) {
  const code = String(value || '').toUpperCase();
  if (!code) return null;
  if (code.includes('DUPLICATE_TOPIC_PUBLICATION_BLOCKED')) return '같은 블로그에 동일하거나 매우 유사한 주제의 더 앞선 글이 있어 발행을 차단했습니다.';
  if (code.includes('API_HUB_404') || code.includes('API_HUB_405')) return '이전 배포에서 사용하던 API 경로 오류 기록입니다. 새 경로에서 성공한 작업이 확인되면 자동으로 정리됩니다.';
  return value;
}

function detailHtml(row) {
  const result = parseResult(row);
  const publication = result?.publication || {};
  const live = livePublication(row?.id);
  const article = result?.article || {};
  const critic = result?.finalCritic || result?.critic || null;
  const title = article.title || row.topic || row.target_url || `Post ${row.blogger_post_id || ''}`;
  const url = publication.url || live?.url || row.target_url || null;
  const score = critic?.score ?? critic?.totalScore ?? null;
  const scheduled = publication.scheduledAt || publication.publishDate || live?.scheduledAt || null;
  const status = publicationAwareStatus(row);
  const mode = row.mode === 'repair_existing' ? '기존글 리페어' : '신규 글';
  const error = friendlyError(row.error || row.last_error_code || live?.errorCode || null);
  const image = imageSummary(row, result);
  const generatedImages = (Array.isArray(row?._images) ? row._images : []).filter((item) => /^https:\/\//i.test(String(item.public_url || '')));
  const imageGallery = generatedImages.length ? `<div class="result-image-gallery">${generatedImages.map((item) => `<a class="result-image-item" href="${escapeHtml(item.public_url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(item.public_url)}" alt="${escapeHtml(item.alt_text || '생성 이미지')}" loading="lazy"><span>${escapeHtml(item.role === 'thumbnail' ? '썸네일' : `본문 ${item.position || ''}`)} · ${escapeHtml(item.provider || '생성 이미지')}${item.status === 'failed' ? ' · QA 확인 필요' : ''}</span></a>`).join('')}</div>` : '';

  return `
    <div class="readable-result">
      <div class="readable-result-head"><strong>작업 결과</strong><span>${escapeHtml(status)}</span></div>
      <dl>
        <div><dt>구분</dt><dd>${escapeHtml(mode)}</dd></div>
        <div><dt>글</dt><dd>${escapeHtml(title)}</dd></div>
        ${score !== null ? `<div><dt>검수 점수</dt><dd>${escapeHtml(score)}점</dd></div>` : ''}
        ${image.visible ? `<div><dt>이미지</dt><dd>${escapeHtml(image.state)}${image.target ? ` · ${escapeHtml(image.current)}/${escapeHtml(image.target)}장` : ''}</dd></div>` : ''}
        ${image.providers.length ? `<div><dt>이미지 엔진</dt><dd>${escapeHtml(image.providers.join(' → '))}</dd></div>` : ''}
        ${image.errorCodes.length ? `<div class="result-error"><dt>이미지 오류</dt><dd>${escapeHtml(image.errorCodes.join(', '))}</dd></div>` : ''}
        ${generatedImages.length ? `<div class="result-images-row"><dt>생성 이미지</dt><dd>${imageGallery}</dd></div>` : ''}
        ${scheduled ? `<div><dt>예약 시각</dt><dd>${escapeHtml(new Date(scheduled).toLocaleString('ko-KR'))}</dd></div>` : ''}
        ${(publication.bloggerPostId || live?.bloggerPostId) ? `<div><dt>Blogger Post</dt><dd>${escapeHtml(publication.bloggerPostId || live?.bloggerPostId)}</dd></div>` : ''}
        ${url ? `<div><dt>글 주소</dt><dd><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></dd></div>` : ''}
        ${error ? `<div class="result-error"><dt>확인 내용</dt><dd>${escapeHtml(error)}</dd></div>` : ''}
      </dl>
    </div>`;
}

async function loadDetail(jobId) {
  const [data, imageData] = await Promise.all([
    adminApi(`/api/jobs/${jobId}`),
    adminApi(`/api/jobs/${jobId}/images`).catch(() => ({ images: [] }))
  ]);
  return { ...(data.job || {}), _images: imageData.images || [] };
}

function retryFailureMessage(error) {
  const code = String(error?.message || '').toUpperCase();
  if (code.includes('MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW')) {
    return 'Blogger에 이미 저장됐을 가능성이 있어 중복 발행 방지를 위해 다시 실행하지 않았습니다. 발행 상태를 먼저 확인해 주세요.';
  }
  if (code.includes('JOB_NOT_RETRYABLE') || code.includes('JOB_RETRY_ALREADY_CLAIMED')) {
    return '이미 다른 실행이 시작됐거나 현재 다시 시도할 수 없는 상태입니다. 큐를 새로고침해 주세요.';
  }
  return `다시 실행하지 못했습니다: ${error.message}`;
}

async function retryJob(jobId, button) {
  if (!isAdminConnected()) return notify('관리 연결 후 다시 시도할 수 있습니다.', 'danger');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '초기화 중';
  try {
    await adminApi(`/api/jobs/${jobId}/retry`, { method: 'POST', body: '{}' });
    button.textContent = '실행 중';
    await adminApi(`/api/jobs/${jobId}/run`, { method: 'POST', body: '{}' });
    notify(`작업 #${jobId}을 같은 큐에서 다시 실행했습니다.`);
    window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId } }));
  } catch (error) {
    notify(retryFailureMessage(error), 'danger');
    window.dispatchEvent(new CustomEvent('orchestrator:jobs-changed', { detail: { jobId } }));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function showReadableDetail(jobId, button) {
  const card = jobList?.querySelector(`[data-job="${jobId}"]`);
  const target = card?.querySelector(`[data-details-for="${jobId}"]`);
  if (!target) return;
  if (!target.hidden) {
    target.hidden = true;
    button.textContent = '결과 보기';
    return;
  }
  button.disabled = true;
  try {
    const row = await loadDetail(jobId);
    target.innerHTML = detailHtml(row);
    target.hidden = false;
    button.textContent = '결과 닫기';
  } catch (error) {
    notify(`결과를 불러오지 못했습니다: ${error.message}`, 'danger');
  } finally {
    button.disabled = false;
  }
}

function sanitizePreviewHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach((node) => node.remove());
  for (const node of doc.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = String(attribute.value || '').trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  return doc.body.innerHTML;
}

function previewDocument(article = {}) {
  const title = String(article.title || 'Smileseon 미리보기');
  const body = sanitizePreviewHtml(article.html || article.content || '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none';"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;line-height:1.75}.wrap{max-width:820px;margin:auto;background:#fff;min-height:100vh;padding:28px 22px 60px;box-sizing:border-box}h1{font-size:30px;line-height:1.3;margin:0 0 24px}h2{font-size:23px;margin-top:34px}h3{font-size:19px;margin-top:28px}img{max-width:100%;height:auto;border-radius:10px}table{width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #cbd5e1;padding:9px}blockquote{margin-left:0;border-left:4px solid #94a3b8;padding-left:14px;color:#475569}.preview-note{font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;padding-bottom:14px;margin-bottom:22px}</style></head><body><main class="wrap"><div class="preview-note">Smileseon 내부 미리보기 · Blogger 발행 전 작성 결과</div><h1>${escapeHtml(title)}</h1>${body || '<p>본문이 아직 준비되지 않았습니다.</p>'}</main></body></html>`;
}

async function previewJob(jobId, button) {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return notify('미리보기 창을 열 수 없습니다. 팝업 허용 상태를 확인해 주세요.', 'danger');
  previewWindow.document.write('<!doctype html><title>미리보기 불러오는 중</title><p style="font-family:sans-serif;padding:24px">작성 결과를 불러오는 중입니다...</p>');
  previewWindow.document.close();
  button.disabled = true;
  try {
    const row = await loadDetail(jobId);
    const result = parseResult(row);
    const live = livePublication(jobId);
    const url = result?.publication?.url || live?.url || row.target_url || null;
    if (url) {
      previewWindow.location.replace(url);
      return;
    }
    const article = result?.article;
    if (!article || (!article.html && !article.content)) {
      previewWindow.close();
      notify('아직 미리보기 가능한 본문이 준비되지 않았습니다.');
      return;
    }
    previewWindow.document.open();
    previewWindow.document.write(previewDocument(article));
    previewWindow.document.close();
  } catch (error) {
    previewWindow.close();
    notify(`미리보기를 열지 못했습니다: ${error.message}`, 'danger');
  } finally {
    button.disabled = false;
  }
}

function applyCardStatus(card, label, tone = 'active') {
  if (!card) return;
  const pill = card.querySelector('.status-pill');
  if (!pill) return;
  if (pill.textContent !== label) pill.textContent = label;
  pill.classList.remove('success', 'neutral', 'danger', 'active');
  pill.classList.add(tone);
  card.classList.toggle('job-failed', label === '실패' || label === '이미지 확인 필요');
  card.classList.toggle('job-review', label === '확인 필요');
  card.classList.toggle('job-complete', ['완료', '발행 완료', '리페어 완료'].includes(label));
  card.classList.toggle('job-ready', ['작성 완료 · 이미지 대기', '이미지 처리 중', '발행 준비 완료', '예약발행 대기', '발행 확인 중', '업데이트 확인 중'].includes(label));
  card.classList.toggle('job-scheduled-update', label === '업데이트 예약');
}

function applyPublicationStatus(card) {
  if (!card) return;
  const jobId = Number(card.dataset.job);
  if (!Number.isInteger(jobId)) return;
  const publication = livePublication(jobId);
  if (!publication) return;
  const label = publicationStatusLabel(publication);
  if (!label) return;
  const tone = ['발행 완료', '리페어 완료'].includes(label)
    ? 'success'
    : (label === '이미지 확인 필요' ? 'danger' : 'active');
  applyCardStatus(card, label, tone);
  const pill = card.querySelector('.status-pill');
  if (!pill) return;
  if (String(publication.status || '') === 'scheduled_update') {
    pill.title = publication.scheduledAt ? `예약 ${new Date(publication.scheduledAt).toLocaleString('ko-KR')}` : '기존글 업데이트 예약됨';
  } else if (String(publication.status || '') === 'scheduled') {
    pill.title = publication.scheduledAt
      ? `예약 발행 ${new Date(publication.scheduledAt).toLocaleString('ko-KR')}`
      : label;
  } else {
    pill.title = label;
  }
}

function schedulePublicationBoundaryRefresh() {
  clearTimeout(publicationBoundaryTimer);
  publicationBoundaryTimer = null;
  const now = Date.now();
  const futureTimes = [...publicationStateByJob.values()]
    .filter((row) => String(row?.status || '') === 'scheduled')
    .map((row) => Date.parse(String(row?.scheduledAt || '')))
    .filter((time) => Number.isFinite(time) && time > now)
    .sort((a, b) => a - b);
  if (!futureTimes.length) return;
  const delay = Math.max(250, Math.min(2147483000, futureTimes[0] - now + 1000));
  publicationBoundaryTimer = setTimeout(() => {
    void refreshPublicationStates();
  }, delay);
}

async function refreshReadyCardState(card) {
  const jobId = Number(card?.dataset?.job);
  if (!Number.isInteger(jobId)) return;
  const current = card.querySelector('.status-pill')?.textContent?.trim() || '';
  if (!['승인/발행 준비', '발행 준비', '작성 완료', '작성 완료 · 이미지 대기', '이미지 처리 중', '발행 준비 완료', '예약발행 대기', '발행 확인 중', '이미지 확인 필요'].includes(current)) return;
  try {
    const row = await loadDetail(jobId);
    if (String(row.status || '') !== 'ready') return;
    const label = publicationAwareStatus(row);
    const tone = label === '이미지 확인 필요' ? 'danger' : 'active';
    applyCardStatus(card, label, tone);
  } catch {
    // Keep the server-rendered status when detail refresh is temporarily unavailable.
  }
}

function enhanceCard(card) {
  if (!card) return;
  applyPublicationStatus(card);
  if (card.dataset.enhanced === 'true') return;
  card.dataset.enhanced = 'true';
  const statusPill = card.querySelector('.status-pill');
  const statusText = statusPill?.textContent?.trim() || '';
  const modeBadge = card.querySelector('.mode-badge');
  const detail = card.querySelector('.job-details');
  const actions = card.querySelector('.job-actions');
  const jobId = Number(card.dataset.job);

  card.classList.toggle('job-failed', statusText === '실패');
  card.classList.toggle('job-review', statusText === '확인 필요');
  card.classList.toggle('job-complete', ['완료', '발행 완료', '리페어 완료'].includes(statusText));
  card.classList.toggle('job-ready', statusText.includes('준비') || ['예약발행 대기', '발행 확인 중', '업데이트 확인 중'].includes(statusText));
  card.classList.toggle('job-scheduled-update', statusText === '업데이트 예약');
  if (modeBadge) modeBadge.setAttribute('title', modeBadge.textContent.trim());

  if (detail) {
    const replacement = document.createElement('div');
    replacement.className = 'job-details readable-job-details';
    replacement.dataset.detailsFor = detail.dataset.detailsFor;
    replacement.hidden = true;
    detail.replaceWith(replacement);
  }

  if (!actions || !Number.isInteger(jobId)) return;
  const detailButton = actions.querySelector('[data-action="detail"]');
  if (detailButton) {
    detailButton.textContent = '결과 보기';
    detailButton.classList.add('card-action', 'result-action');
  }

  const existingRun = actions.querySelector('[data-action="run"]');
  if (existingRun) {
    existingRun.textContent = '지금 실행';
    existingRun.classList.add('card-action', 'primary-card-action');
  }

  if (['실패', '확인 필요'].includes(statusText) && !actions.querySelector('[data-action="retry-readable"]')) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = `button small card-action ${statusText === '실패' ? 'danger-action' : 'review-action'}`;
    retry.dataset.action = 'retry-readable';
    retry.dataset.jobId = String(jobId);
    retry.textContent = statusText === '실패' ? '다시 시도' : '재작성';
    actions.appendChild(retry);
  }

  if (['완료', '발행 완료', '리페어 완료', '승인/발행 준비', '발행 준비', '발행 준비 완료', '예약발행 대기', '발행 확인 중', '업데이트 확인 중', '업데이트 예약', '확인 필요'].includes(statusText) && !actions.querySelector('[data-action="preview-readable"]')) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'button small ghost card-action preview-action';
    preview.dataset.action = 'preview-readable';
    preview.dataset.jobId = String(jobId);
    preview.textContent = '미리보기';
    actions.appendChild(preview);
  }
}

function enhanceAll() {
  jobList?.querySelectorAll('.job-row').forEach(enhanceCard);
}

function applyPublicationStatuses() {
  jobList?.querySelectorAll('.job-row').forEach(applyPublicationStatus);
}

async function refreshReadyCards() {
  if (readyRefreshPromise) return readyRefreshPromise;
  readyRefreshPromise = (async () => {
    const cards = [...(jobList?.querySelectorAll('.job-row') || [])];
    for (const card of cards) await refreshReadyCardState(card);
  })().finally(() => { readyRefreshPromise = null; });
  return readyRefreshPromise;
}

async function refreshPublicationStates() {
  if (!isAdminConnected()) return;
  if (publicationRefreshPromise) return publicationRefreshPromise;
  publicationRefreshPromise = (async () => {
    try {
      const data = await adminApi('/api/operations/publications/today');
      publicationStateByJob = new Map((data.rows || []).map((row) => [Number(row.jobId), row]));
      applyPublicationStatuses();
      schedulePublicationBoundaryRefresh();
      await refreshReadyCards();
    } catch {
      publicationStateByJob = new Map();
      clearTimeout(publicationBoundaryTimer);
      publicationBoundaryTimer = null;
    } finally {
      publicationRefreshPromise = null;
    }
  })();
  return publicationRefreshPromise;
}

jobList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (!['detail', 'retry-readable', 'preview-readable'].includes(action)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const jobId = Number(button.dataset.jobId);
  if (!Number.isInteger(jobId)) return;
  if (action === 'detail') return showReadableDetail(jobId, button);
  if (action === 'retry-readable') return retryJob(jobId, button);
  if (action === 'preview-readable') return previewJob(jobId, button);
}, true);

window.addEventListener('orchestrator:jobs-changed', () => void refreshPublicationStates());
window.addEventListener('focus', () => void refreshPublicationStates());

if (jobList) {
  new MutationObserver(() => {
    enhanceAll();
    if (jobList.querySelector('.job-row')) void refreshPublicationStates();
  }).observe(jobList, { childList: true });
  enhanceAll();
  void refreshPublicationStates();
}
