import { adminApi, isAdminConnected } from './admin-session.js';

if (!document.querySelector('link[data-automation-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './automation.css';
  link.dataset.automationCss = 'true';
  document.head.appendChild(link);
}

const PUBLISH_CONTROL_NAMES = new Set([
  'publishStartTime',
  'publishIntervalMinutes',
  'publishJitterMinutes',
  'maxPublishesPerDay',
  'approvalMode'
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function field(name, label, type = 'number', attrs = '') {
  return `<label class="automation-field">${escapeHtml(label)}<input name="${name}" type="${type}" ${attrs}></label>`;
}

function selectField(name, label, options) {
  return `<label class="automation-field">${escapeHtml(label)}<select name="${name}">${options.map(([value, text]) => `<option value="${value}">${escapeHtml(text)}</option>`).join('')}</select></label>`;
}

function checkField(name, label) {
  return `<label class="automation-check"><input name="${name}" type="checkbox"><span>${escapeHtml(label)}</span></label>`;
}

function globalScheduleFields() {
  return `
    <div class="automation-grid automation-global-schedule">
      ${field('dailyOperationStartTime', '일일 자동운영 시작', 'time', 'step="300"')}
    </div>
    <div class="automation-warning">매일 이 시각에 블로그 상태 진단과 그날의 작업 계획을 시작합니다. 설정을 바꾸면 오늘 계획도 즉시 다시 계산되고, 이후 5분마다 상태를 자동 복구합니다.</div>`;
}

function settingsFields() {
  return `
    <div class="automation-grid">
      ${checkField('enabled', '이 블로그 자동화 사용')}
      ${selectField('contentLanguage', '글 작성 언어', [['auto', '자동 · Blogger 언어 설정'], ['ko', '한국어 고정'], ['en', 'English 고정']])}
      ${checkField('autoPublishEnabled', '예약 발행/예약 업데이트 사용')}
      ${checkField('newArticlesEnabled', '신규 글 생성')}
      ${field('newArticlesPerDay', '하루 신규 글 수', 'number', 'min="0" max="10" step="1"')}
      ${checkField('repairsEnabled', '기존 글 리페어')}
      ${field('repairsPerDay', '하루 리페어 최대 수', 'number', 'min="0" max="10" step="1"')}
      ${field('publishStartTime', '예약 기준 시작', 'time')}
      ${field('publishIntervalMinutes', '기준 간격(분)', 'number', 'min="5" max="720" step="1"')}
      ${field('publishJitterMinutes', '랜덤 분산 ±(분)', 'number', 'min="0" max="60" step="1"')}
      ${field('maxPublishesPerDay', '하루 최대 예약/업데이트 수', 'number', 'min="0" max="20" step="1"')}
      ${selectField('approvalMode', '처리 방식', [['approval', '승인대기'], ['auto', '자동 예약']])}
      ${checkField('imagesEnabled', '썸네일/본문 이미지 생성')}
      ${field('bodyImageCount', '본문 이미지 수', 'number', 'min="0" max="3" step="1"')}
      ${selectField('operationMode', '운영 모드', [['growth', '성장'], ['recovery', '회복'], ['validation', '검증']])}
      <label class="automation-field">시간대<input name="timezone" value="Asia/Seoul" readonly></label>
    </div>`;
}

function setFormValues(form, settings) {
  if (!form) return;
  for (const [key, value] of Object.entries(settings || {})) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
}

function settingsFromForm(form) {
  const value = (name) => form.elements.namedItem(name)?.value;
  const checked = (name) => Boolean(form.elements.namedItem(name)?.checked);
  return {
    enabled: checked('enabled'),
    dailyOperationStartTime: value('dailyOperationStartTime') || undefined,
    newArticlesEnabled: checked('newArticlesEnabled'),
    repairsEnabled: checked('repairsEnabled'),
    newArticlesPerDay: Number(value('newArticlesPerDay')),
    repairsPerDay: Number(value('repairsPerDay')),
    // Compatibility field only. User-entered counts are always the healthy-state target now.
    fixedDailyTargets: true,
    autoPublishEnabled: checked('autoPublishEnabled'),
    publishStartTime: value('publishStartTime'),
    publishIntervalMinutes: Number(value('publishIntervalMinutes')),
    publishJitterMinutes: Number(value('publishJitterMinutes')),
    maxPublishesPerDay: Number(value('maxPublishesPerDay')),
    imagesEnabled: checked('imagesEnabled'),
    bodyImageCount: Number(value('bodyImageCount')),
    approvalMode: value('approvalMode'),
    operationMode: value('operationMode'),
    contentLanguage: value('contentLanguage') || 'auto',
    timezone: value('timezone') || 'Asia/Seoul'
  };
}

function languageLabel(language) {
  return language === 'en' ? 'English' : '한국어';
}

function summaryText(blog) {
  const settings = blog.effective;
  if (!settings.enabled) return `⚪ OFF · ${languageLabel(blog.resolvedLanguage)}`;
  const publish = settings.autoPublishEnabled
    ? (settings.approvalMode === 'auto'
      ? `🟢 자동 예약 ${settings.publishIntervalMinutes}±${settings.publishJitterMinutes}분`
      : '🟡 예약 사용 · 승인대기')
    : '🟡 예약 발행 OFF';
  const newCount = settings.newArticlesEnabled ? settings.newArticlesPerDay : 0;
  const repairCount = settings.repairsEnabled ? settings.repairsPerDay : 0;
  return `${publish} · ${languageLabel(blog.resolvedLanguage)} · 신규 ${newCount} / 리페어 최대 ${repairCount}`;
}

function syncPublishControls(form, forceDisabled = false) {
  if (!form) return;
  const autoPublishEnabled = Boolean(form.elements.namedItem('autoPublishEnabled')?.checked);
  for (const name of PUBLISH_CONTROL_NAMES) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    const disabled = forceDisabled || !autoPublishEnabled;
    input.disabled = disabled;
    input.closest('.automation-field')?.classList.toggle('automation-field-disabled', disabled);
  }
}

function ensurePanel() {
  let panel = document.querySelector('#automation-panel');
  if (panel) return panel;
  const host = document.querySelector('#automation-host');
  if (!host) return null;
  panel = document.createElement('section');
  panel.id = 'automation-panel';
  panel.className = 'panel automation-panel';
  panel.innerHTML = `
    <div class="automation-toolbar">
      <div><p class="section-kicker">AUTOMATION</p><h2>블로그 자동화 설정</h2></div>
      <span id="automation-state" class="status-pill neutral">관리 연결 필요</span>
    </div>
    <p class="hint">하루 신규 글 수와 리페어 최대 수가 실제 일일 목표입니다. 안전상 일시 정지 상태가 생기면 잠시 멈췄다가 상태가 풀리는 즉시 오늘 계획을 자동 복구합니다.</p>
    <div id="automation-content"><p class="muted">관리 연결 후 설정을 불러옵니다.</p></div>`;
  host.appendChild(panel);
  return panel;
}

function state(message, tone = 'neutral') {
  const target = document.querySelector('#automation-state');
  if (!target) return;
  target.textContent = message;
  target.className = `status-pill ${tone}`;
}

function setOverrideEnabled(details) {
  const inherit = details.querySelector('input[name="inheritGlobal"]')?.checked !== false;
  const form = details.querySelector('[data-blog-form]');
  details.querySelector('.automation-blog-body')?.setAttribute('data-inherit', String(inherit));
  for (const input of details.querySelectorAll('.automation-overrides input, .automation-overrides select')) input.disabled = inherit;
  if (!inherit) syncPublishControls(form, false);
}

function renderSettings(data) {
  const content = document.querySelector('#automation-content');
  if (!content) return;
  const blogs = Array.isArray(data?.blogs) ? data.blogs : [];
  content.innerHTML = `
    <form id="automation-global-form" class="automation-global">
      <h3>전체 기본 설정</h3>
      ${globalScheduleFields()}
      ${settingsFields()}
      <div class="automation-warning">예약 발행을 끄면 예약 시간·간격 항목만 비활성화됩니다. 신규 글 작성과 리페어 자체는 계속 실행됩니다.</div>
      <div class="automation-actions"><button class="button primary" type="submit">전체 설정 저장</button></div>
    </form>
    <div class="automation-blogs">
      ${blogs.map((blog) => `
        <details class="automation-blog" data-blog-id="${escapeHtml(blog.blogId)}">
          <summary>
            <span class="automation-blog-title"><strong>${escapeHtml(blog.name)}</strong><small>${escapeHtml(blog.url || blog.blogId)} · 감지 ${escapeHtml(languageLabel(blog.resolvedLanguage))}</small></span>
            <span class="automation-summary">${escapeHtml(summaryText(blog))}</span>
          </summary>
          <form class="automation-blog-body" data-blog-form>
            <div class="language-detected">Blogger 감지 언어: <strong>${escapeHtml(blog.detectedLanguage || '미설정')}</strong> → 현재 작성 언어: <strong>${escapeHtml(languageLabel(blog.resolvedLanguage))}</strong></div>
            <label class="automation-check automation-inherit"><input name="inheritGlobal" type="checkbox" ${blog.inheritGlobal ? 'checked' : ''}><span>전체 설정 사용</span></label>
            <div class="automation-overrides">${settingsFields()}</div>
            <div class="automation-actions"><button class="button" type="submit">이 블로그 설정 저장</button></div>
          </form>
        </details>`).join('')}
    </div>
    <section class="automation-preview">
      <div class="panel-head"><h3>오늘 실행 미리보기</h3><button id="refresh-automation-preview" class="button small ghost" type="button">새로고침</button></div>
      <div id="automation-preview-list" class="automation-preview-list"><p class="automation-empty">미리보기를 불러오는 중입니다.</p></div>
    </section>`;

  const globalForm = document.querySelector('#automation-global-form');
  setFormValues(globalForm, data.global || {});
  syncPublishControls(globalForm, false);
  for (const details of document.querySelectorAll('.automation-blog')) {
    const blog = blogs.find((item) => String(item.blogId) === String(details.dataset.blogId));
    const form = details.querySelector('[data-blog-form]');
    setFormValues(form, blog?.override || blog?.effective || data.global || {});
    const inherit = form?.elements.namedItem('inheritGlobal');
    if (inherit) inherit.checked = blog?.inheritGlobal !== false;
    setOverrideEnabled(details);
  }
}

function planReason(decision) {
  const label = String(decision?.priorityLabel || '');
  if (label === 'held') return '보류 작업 확인 필요';
  if (label === 'review') return '검토 대기 작업 존재';
  if (label === 'retry_wait') return '일시 오류 자동 복구 대기';
  if (label === 'backlog') return '실행 중 작업 정리 대기';
  if (label === 'paused') return '자동화 OFF';
  return '';
}

async function loadPreview() {
  const target = document.querySelector('#automation-preview-list');
  if (!target || !isAdminConnected()) return;
  try {
    const [previewResult, workloadResult] = await Promise.allSettled([
      adminApi('/api/automation/preview'),
      adminApi('/api/operations/workload/today')
    ]);
    if (previewResult.status !== 'fulfilled') throw previewResult.reason;
    const preview = previewResult.value;
    const workload = workloadResult.status === 'fulfilled' ? workloadResult.value : { decisions: [] };
    const plannedByBlog = new Map((workload.decisions || []).map((item) => [String(item.blogId), item]));
    const rows = Array.isArray(preview.blogs) ? preview.blogs : [];

    target.innerHTML = rows.length ? rows.map((blog) => {
      const times = blog.publishing.times || [];
      const configuredNew = Number(blog.work.newArticles || 0);
      const configuredRepairs = Number(blog.work.repairs || 0);
      const decision = plannedByBlog.get(String(blog.blogId)) || null;
      const plannedNew = decision ? Number(decision.newArticles || 0) : null;
      const plannedRepairs = decision ? Number(decision.repairs || 0) : null;
      const mismatch = Boolean(decision && blog.enabled && (plannedNew !== configuredNew || plannedRepairs !== configuredRepairs));
      const reason = mismatch ? planReason(decision) : '';
      const work = `언어 ${languageLabel(blog.resolvedLanguage)} · 설정 목표 신규 ${configuredNew} / 리페어 최대 ${configuredRepairs}${blog.work.imagesEnabled ? ` · 이미지 ${blog.work.bodyImageCount}+썸네일` : ' · 이미지 OFF'}`;
      const actual = decision
        ? `오늘 실제 계획 신규 ${plannedNew} / 리페어 ${plannedRepairs}${reason ? ` · ${reason}` : ''}`
        : '오늘 실제 계획 미생성 · 자동 복구 대기';
      const schedule = !blog.enabled
        ? '자동화 OFF'
        : blog.publishing.autoPublishEnabled
          ? (times.length
            ? `${times.join(' · ')} · 기준 ${blog.publishing.intervalMinutes}±${blog.publishing.jitterMinutes}분`
            : '예약 발행 사용 · 예약 가능 작업 대기')
          : '예약 발행 OFF · 글 작성/리페어는 계속 실행';
      return `<div class="automation-preview-row${mismatch ? ' attention' : ''}"><div><strong>${escapeHtml(blog.name)}</strong><small>${escapeHtml(work)}</small><small class="automation-plan-line${mismatch ? ' automation-plan-alert' : ''}">${escapeHtml(actual)}</small></div><div class="automation-times">${escapeHtml(schedule)}</div></div>`;
    }).join('') : '<p class="automation-empty">표시할 블로그가 없습니다.</p>';
  } catch (error) {
    target.innerHTML = `<p class="automation-empty">미리보기 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

export async function loadAutomation() {
  const panel = ensurePanel();
  const content = document.querySelector('#automation-content');
  if (!panel) return;
  if (!isAdminConnected()) {
    state('관리 연결 필요');
    if (content) content.innerHTML = '<p class="muted">관리 연결 후 설정을 불러옵니다.</p>';
    return;
  }
  state('불러오는 중', 'active');
  try {
    const data = await adminApi('/api/automation/settings');
    renderSettings(data);
    state(`${data.blogs?.length || 0}개 블로그`, 'success');
    await loadPreview();
  } catch (error) {
    state('설정 조회 실패', 'danger');
    if (content) content.innerHTML = `<p class="job-error">자동화 설정 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

async function replanTodayAfterSave() {
  try {
    await adminApi('/api/operations/plan-today', { method: 'POST', body: '{}' });
    return true;
  } catch {
    // The five-minute self-healer will retry from current settings even if this immediate call fails.
    return false;
  }
}

const panel = ensurePanel();
panel?.addEventListener('change', (event) => {
  if (event.target?.name === 'inheritGlobal') {
    const details = event.target.closest('.automation-blog');
    if (details) setOverrideEnabled(details);
    return;
  }
  if (event.target?.name === 'autoPublishEnabled') {
    const form = event.target.closest('form');
    const details = form?.closest('.automation-blog');
    const inherited = Boolean(details && form.elements.namedItem('inheritGlobal')?.checked !== false);
    syncPublishControls(form, inherited);
  }
});

panel?.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    if (form.id === 'automation-global-form') {
      await adminApi('/api/automation/settings/global', { method: 'PUT', body: JSON.stringify(settingsFromForm(form)) });
    } else if (form.matches('[data-blog-form]')) {
      const details = form.closest('.automation-blog');
      const blogId = details?.dataset.blogId;
      await adminApi(`/api/automation/settings/blogs/${encodeURIComponent(blogId)}`, {
        method: 'PUT',
        body: JSON.stringify({ inheritGlobal: form.elements.namedItem('inheritGlobal')?.checked !== false, settings: settingsFromForm(form) })
      });
    }
    const replanned = await replanTodayAfterSave();
    await loadAutomation();
    state(replanned ? '저장 · 오늘 계획 반영 완료' : '저장 완료 · 계획 자동복구 대기', replanned ? 'success' : 'active');
  } catch (error) {
    state(`저장 실패: ${error.message}`, 'danger');
  } finally {
    if (button) button.disabled = false;
  }
});

panel?.addEventListener('click', (event) => {
  if (event.target?.id === 'refresh-automation-preview') loadPreview();
});

window.addEventListener('orchestrator:admin-session', loadAutomation);
window.addEventListener('orchestrator:open-blog-automation', (event) => {
  const blogId = String(event.detail?.blogId || '');
  if (!blogId) return;
  const details = document.querySelector(`.automation-blog[data-blog-id="${CSS.escape(blogId)}"]`);
  if (details) {
    details.open = true;
    setTimeout(() => details.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }
});
loadAutomation();
