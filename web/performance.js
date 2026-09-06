import { adminApi, isAdminConnected } from './admin-session.js';

const state = document.querySelector('#gsc-state');
const summary = document.querySelector('#gsc-summary');
const cards = document.querySelector('#gsc-blog-cards');
const refresh = document.querySelector('#refresh-gsc');

let connectedBlogs = [];
let adsenseOrder = 'earnings';
let selectedBlogId = '';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function number(value) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function decimal(value, digits = 2) {
  return new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(Number(value || 0));
}

function money(value, currency) {
  const code = String(currency || '').toUpperCase();
  try {
    if (code) return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(Number(value || 0));
  } catch {}
  return decimal(value, 2);
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function position(value) {
  const numeric = Number(value || 0);
  return numeric > 0 ? numeric.toFixed(1) : '-';
}

function setState(message, tone = 'neutral') {
  if (!state) return;
  state.textContent = message;
  state.className = `status-pill ${tone}`;
}

function snapshotMap(snapshots = []) {
  const map = new Map();
  for (const row of snapshots) map.set(`${row.blog_id}:${Number(row.window_days)}`, row);
  return map;
}

function aggregate(rows = []) {
  const clicks = rows.reduce((sum, row) => sum + Number(row?.clicks || 0), 0);
  const impressions = rows.reduce((sum, row) => sum + Number(row?.impressions || 0), 0);
  const weightedPosition = rows.reduce((sum, row) => sum + Number(row?.position || 0) * Number(row?.impressions || 0), 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0
  };
}

function render(data) {
  const properties = Array.isArray(data?.properties) ? data.properties : [];
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  const bySnapshot = snapshotMap(snapshots);
  const rows28 = snapshots.filter((row) => Number(row.window_days) === 28 && row.status === 'ok');
  const total = aggregate(rows28);

  summary.innerHTML = `
    <div><strong>${number(total.clicks)}</strong><span>28일 클릭</span></div>
    <div><strong>${number(total.impressions)}</strong><span>28일 노출</span></div>
    <div><strong>${percent(total.ctr)}</strong><span>통합 CTR</span></div>
    <div><strong>${position(total.position)}</strong><span>가중 평균순위</span></div>
  `;

  cards.innerHTML = properties.map((property) => {
    const blogId = String(property.blog_id);
    const seven = bySnapshot.get(`${blogId}:7`);
    const twentyEight = bySnapshot.get(`${blogId}:28`);
    const ready = seven?.status === 'ok' && twentyEight?.status === 'ok';
    return `
      <article class="card ${ready ? '' : 'danger'}">
        <span>${escapeHtml(property.blog_name || `Blog ${blogId}`)}</span>
        <strong>${number(twentyEight?.clicks || 0)} 클릭 · ${number(twentyEight?.impressions || 0)} 노출</strong>
        <small>28일 CTR ${percent(twentyEight?.ctr || 0)} · 평균순위 ${position(twentyEight?.position || 0)}</small>
        <small>최근 7일 ${number(seven?.clicks || 0)} 클릭 · ${number(seven?.impressions || 0)} 노출</small>
      </article>`;
  }).join('') || '<p class="muted">아직 Search Console 스냅샷이 없습니다.</p>';

  setState(
    `${properties.length}개 블로그 · 매일 ${escapeHtml(data?.collectionTime || '03:15')} 자동수집`,
    data?.collectionEnabled && properties.length > 0 && rows28.length === properties.length ? 'success' : 'active'
  );
}

function ensureAdsensePanel() {
  let panel = document.querySelector('#adsense-page-performance-panel');
  if (panel) return panel;
  const gscPanel = document.querySelector('#gsc-performance-panel');
  if (!gscPanel) return null;
  panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'adsense-page-performance-panel';
  panel.innerHTML = `
    <div class="panel-head queue-head">
      <div><p class="section-kicker">REVENUE PERFORMANCE</p><h2>오늘 돈 버는 글</h2></div>
      <div class="actions">
        <button id="collect-adsense-pages" class="button ghost" type="button">오늘 데이터 수집</button>
        <button id="refresh-adsense-pages" class="button ghost" type="button">새로고침</button>
      </div>
    </div>
    <div class="form-stack">
      <label>블로그<select id="adsense-blog-select"><option value="">블로그를 선택하세요</option></select></label>
    </div>
    <div class="actions" id="adsense-page-tabs" style="margin-top:12px;justify-content:flex-start">
      <button class="button small primary" type="button" data-adsense-order="earnings">수익 TOP10</button>
      <button class="button small ghost" type="button" data-adsense-order="rpm">RPM TOP10</button>
      <button class="button small ghost" type="button" data-adsense-order="views">페이지뷰 TOP10</button>
    </div>
    <div class="panel-head compact-head" style="margin-top:12px">
      <p id="adsense-page-hint" class="hint no-top-margin">블로그를 선택하면 오늘 글별 광고 성과를 확인합니다.</p>
      <span id="adsense-page-state" class="status-pill neutral">블로그 선택</span>
    </div>
    <div id="adsense-page-summary" class="queue-summary"></div>
    <div id="adsense-page-list" class="job-list" aria-live="polite"><p class="muted">아직 조회하지 않았습니다.</p></div>`;
  gscPanel.insertAdjacentElement('afterend', panel);

  panel.querySelector('#adsense-blog-select')?.addEventListener('change', (event) => {
    selectedBlogId = event.target.value;
    loadAdsensePages();
  });
  panel.querySelector('#refresh-adsense-pages')?.addEventListener('click', loadAdsensePages);
  panel.querySelector('#collect-adsense-pages')?.addEventListener('click', collectAdsensePages);
  panel.querySelectorAll('[data-adsense-order]').forEach((button) => button.addEventListener('click', () => {
    adsenseOrder = button.dataset.adsenseOrder || 'earnings';
    panel.querySelectorAll('[data-adsense-order]').forEach((item) => {
      item.classList.toggle('primary', item.dataset.adsenseOrder === adsenseOrder);
      item.classList.toggle('ghost', item.dataset.adsenseOrder !== adsenseOrder);
    });
    loadAdsensePages();
  }));
  return panel;
}

function fillAdsenseBlogs() {
  const panel = ensureAdsensePanel();
  const select = panel?.querySelector('#adsense-blog-select');
  if (!select) return;
  const previous = selectedBlogId || select.value;
  select.innerHTML = '<option value="">블로그를 선택하세요</option>' + connectedBlogs.map((blog) =>
    `<option value="${escapeHtml(blog.blogId)}">${escapeHtml(blog.name || blog.url || blog.blogId)}</option>`
  ).join('');
  if (previous && connectedBlogs.some((blog) => String(blog.blogId) === String(previous))) {
    select.value = previous;
    selectedBlogId = previous;
  } else if (connectedBlogs.length) {
    select.value = String(connectedBlogs[0].blogId);
    selectedBlogId = select.value;
  }
}

function safePageHref(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function renderAdsensePages(data) {
  const panel = ensureAdsensePanel();
  if (!panel) return;
  const list = panel.querySelector('#adsense-page-list');
  const summaryEl = panel.querySelector('#adsense-page-summary');
  const stateEl = panel.querySelector('#adsense-page-state');
  const hint = panel.querySelector('#adsense-page-hint');
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const totalViews = rows.reduce((sum, row) => sum + Number(row.page_views || 0), 0);
  const totalEarnings = rows.reduce((sum, row) => sum + Number(row.estimated_earnings || 0), 0);
  const totalClicks = rows.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
  const currency = rows.find((row) => row.currency_code)?.currency_code || '';
  const weightedRpm = totalViews > 0 ? rows.reduce((sum, row) => sum + Number(row.page_views_rpm || 0) * Number(row.page_views || 0), 0) / totalViews : 0;

  summaryEl.innerHTML = `
    <div><strong>${money(totalEarnings, currency)}</strong><span>표시 글 수익 합계</span></div>
    <div><strong>${decimal(weightedRpm, 2)}</strong><span>가중 RPM</span></div>
    <div><strong>${number(totalViews)}</strong><span>페이지뷰</span></div>
    <div><strong>${number(totalClicks)}</strong><span>클릭</span></div>`;

  const orderLabel = data?.order === 'rpm' ? 'RPM' : data?.order === 'views' ? '페이지뷰' : '수익';
  stateEl.textContent = `${orderLabel} TOP${rows.length}`;
  stateEl.className = `status-pill ${rows.length ? 'success' : 'neutral'}`;
  hint.textContent = data?.preliminary
    ? '오늘 데이터는 잠정값입니다. RPM 탭은 페이지뷰 3 이상인 글만 표시합니다.'
    : '확정된 일자별 글 성과입니다.';

  list.innerHTML = rows.map((row, index) => {
    const href = safePageHref(row.page_url);
    const title = row.page_path || row.page_url || '(URL 없음)';
    return `<article class="job-row">
      <div class="job-topline"><div><span class="job-id">#${index + 1}</span><span class="mode-badge">${escapeHtml(orderLabel)}</span></div><strong>${money(row.estimated_earnings, row.currency_code)}</strong></div>
      <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${escapeHtml(title)}</a>` : escapeHtml(title)}</h3>
      <div class="job-meta">
        <span>RPM ${decimal(row.page_views_rpm, 2)}</span>
        <span>페이지뷰 ${number(row.page_views)}</span>
        <span>노출 ${number(row.impressions)}</span>
        <span>클릭 ${number(row.clicks)}</span>
      </div>
    </article>`;
  }).join('') || '<p class="muted">이 블로그의 오늘 페이지 단위 AdSense 데이터가 아직 없습니다. “오늘 데이터 수집”을 실행한 뒤 다시 확인하세요.</p>';
}

async function loadAdsensePages() {
  const panel = ensureAdsensePanel();
  if (!panel) return;
  const stateEl = panel.querySelector('#adsense-page-state');
  const list = panel.querySelector('#adsense-page-list');
  const summaryEl = panel.querySelector('#adsense-page-summary');
  if (!isAdminConnected()) {
    stateEl.textContent = '관리 연결 필요';
    stateEl.className = 'status-pill neutral';
    summaryEl.innerHTML = '';
    list.innerHTML = '<p class="muted">관리 연결 후 글별 AdSense 성과를 확인합니다.</p>';
    return;
  }
  if (!selectedBlogId) {
    stateEl.textContent = '블로그 선택';
    stateEl.className = 'status-pill neutral';
    summaryEl.innerHTML = '';
    list.innerHTML = '<p class="muted">조회할 블로그를 선택하세요.</p>';
    return;
  }
  stateEl.textContent = '불러오는 중';
  stateEl.className = 'status-pill active';
  const minPageViews = adsenseOrder === 'rpm' ? 3 : 0;
  try {
    const path = `/api/performance/adsense/blogs/${encodeURIComponent(selectedBlogId)}/pages?limit=10&order=${encodeURIComponent(adsenseOrder)}&minPageViews=${minPageViews}`;
    renderAdsensePages(await adminApi(path));
  } catch (error) {
    stateEl.textContent = '조회 실패';
    stateEl.className = 'status-pill danger';
    list.innerHTML = `<p class="job-error">글별 AdSense 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

async function collectAdsensePages() {
  const panel = ensureAdsensePanel();
  const button = panel?.querySelector('#collect-adsense-pages');
  const stateEl = panel?.querySelector('#adsense-page-state');
  if (!isAdminConnected() || !button) return;
  button.disabled = true;
  if (stateEl) {
    stateEl.textContent = '수집 중';
    stateEl.className = 'status-pill active';
  }
  try {
    await adminApi('/api/performance/adsense/pages/collect', { method: 'POST' });
    await loadAdsensePages();
  } catch (error) {
    if (stateEl) {
      stateEl.textContent = '수집 실패';
      stateEl.className = 'status-pill danger';
    }
    panel.querySelector('#adsense-page-list').innerHTML = `<p class="job-error">AdSense 페이지 수집 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

export async function loadGscPerformance() {
  if (!summary || !cards) return;
  if (!isAdminConnected()) {
    setState('관리 연결 필요');
    summary.innerHTML = '';
    cards.innerHTML = '<p class="muted">관리 연결 후 Search Console 성과를 확인합니다.</p>';
    return;
  }
  setState('불러오는 중', 'active');
  try {
    render(await adminApi('/api/performance/gsc/today'));
  } catch (error) {
    setState('조회 실패', 'danger');
    cards.innerHTML = `<p class="job-error">Search Console 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

refresh?.addEventListener('click', loadGscPerformance);
window.addEventListener('orchestrator:blogs-loaded', (event) => {
  connectedBlogs = Array.isArray(event.detail?.blogs) ? event.detail.blogs : [];
  fillAdsenseBlogs();
  if (selectedBlogId) loadAdsensePages();
});
window.addEventListener('orchestrator:admin-session', () => {
  loadGscPerformance();
  loadAdsensePages();
});
window.addEventListener('orchestrator:jobs-changed', loadGscPerformance);
ensureAdsensePanel();
loadGscPerformance();
