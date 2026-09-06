import { adminApi, isAdminConnected } from './admin-session.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.hostname}${url.pathname}`.replace(/\/$/, '');
  } catch { return String(value || '-'); }
}

function ensurePanel() {
  let panel = document.querySelector('#trend-keyword-panel');
  if (panel) return panel;
  const home = document.querySelector('[data-view="home"]');
  if (!home) return null;
  panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'trend-keyword-panel';
  panel.innerHTML = `
    <div class="panel-head queue-head">
      <div><p class="section-kicker">TREND & RANKING</p><h2>트렌드 키워드 · 실제 검색순위</h2></div>
      <button id="refresh-trend-keywords" class="button ghost" type="button">트렌드 수집</button>
    </div>
    <div class="panel-head compact-head">
      <p class="hint">Google Trends 급상승어 중 블로그 주제와 맞는 것만 신규글 후보로 사용합니다. GSC 순위는 고정 순위가 아니라 기간 평균 position입니다.</p>
      <span id="trend-keyword-state" class="status-pill neutral">관리 연결 필요</span>
    </div>
    <div id="trend-keyword-summary" class="queue-summary"></div>
    <details class="phase-entry" open>
      <summary><strong>트렌드 후보</strong><span id="trend-keyword-count">0</span></summary>
      <p class="hint">SEO 경쟁도는 Google Ads 경쟁률이 아닌 Smileseon 내부 추정치입니다. Google Trends 데이터 사용 시 출처는 Google Trends입니다.</p>
      <div id="trend-keyword-list" class="job-list"><p class="muted">트렌드 데이터를 불러오는 중입니다.</p></div>
    </details>
    <details class="phase-entry" open>
      <summary><strong>검색어별 실제 순위</strong><span id="keyword-ranking-count">0</span></summary>
      <p class="hint">GSC에 노출이 기록된 검색어만 표시합니다. 노출이 없다는 사실만으로 미색인이라고 단정하지 않습니다.</p>
      <div id="keyword-ranking-list" class="job-list"><p class="muted">검색 순위를 불러오는 중입니다.</p></div>
    </details>`;
  const strategy = document.querySelector('#content-strategy-panel');
  const gsc = document.querySelector('#gsc-performance-panel');
  if (strategy?.parentNode) strategy.after(panel);
  else if (gsc?.parentNode) gsc.after(panel);
  else home.appendChild(panel);
  return panel;
}

function competitionLabel(value) {
  return ({ low: '낮음', medium: '중간', high: '높음' })[String(value || '')] || '추정중';
}

function competitionClass(value) {
  return String(value) === 'high' ? 'danger' : String(value) === 'low' ? 'success' : 'active';
}

function decisionLabel(value) {
  return ({
    new_article: 'TREND 신규글',
    repair_existing: '기존글 업데이트 후보',
    existing_candidate: '기존 후보와 중복',
    watch: '관찰'
  })[String(value || '')] || String(value || '관찰');
}

function trafficText(row) {
  if (row.approx_traffic_text) return row.approx_traffic_text;
  const value = Number(row.approx_traffic_value || 0);
  return value > 0 ? `${value.toLocaleString()}+` : '-';
}

function renderTrends(rows) {
  const host = document.querySelector('#trend-keyword-list');
  const count = document.querySelector('#trend-keyword-count');
  if (count) count.textContent = String(rows.length);
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<p class="muted">현재 블로그 주제와 충분히 관련된 급상승 키워드가 없습니다. 좋은 트렌드가 없으면 기존 전략 글을 사용합니다.</p>';
    return;
  }
  host.innerHTML = rows.slice(0, 30).map((row) => `
    <article class="job-row">
      <div class="job-topline">
        <div><span class="mode-badge">Google Trends · ${escapeHtml(row.geo || '-')}</span><span class="job-id">${escapeHtml(decisionLabel(row.decision))}</span></div>
        <span class="status-pill ${competitionClass(row.competition_label)}">경쟁 ${competitionLabel(row.competition_label)} · ${Number(row.competition_score || 0).toFixed(0)}/100</span>
      </div>
      <h3>${escapeHtml(row.query)}</h3>
      <div class="job-meta">
        <span>급상승 검색 ${escapeHtml(trafficText(row))}</span>
        <span>관련도 ${(Number(row.relevance_score || 0) * 100).toFixed(0)}%</span>
        <span>트렌드 ${Number(row.trend_score || 0).toFixed(0)}</span>
      </div>
      ${row.target_page ? `<p class="hint">기존 대상: ${escapeHtml(shortUrl(row.target_page))}</p>` : '<p class="hint">기존 글과 강한 중복이 없으면 하루 최대 1개 TREND 신규글 후보로 승격됩니다.</p>'}
    </article>`).join('');
}

function rankChange(row) {
  const value = Number(row.rankChange);
  if (!Number.isFinite(value) || row.rankChange === null) return '비교 없음';
  if (Math.abs(value) < 0.05) return '변동 없음';
  return value > 0 ? `▲ ${value.toFixed(1)}` : `▼ ${Math.abs(value).toFixed(1)}`;
}

function renderRankings(rows) {
  const host = document.querySelector('#keyword-ranking-list');
  const count = document.querySelector('#keyword-ranking-count');
  if (count) count.textContent = String(rows.length);
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<p class="muted">아직 GSC에 검색 노출이 기록된 검색어가 없습니다.</p>';
    return;
  }
  host.innerHTML = rows.slice(0, 60).map((row) => `
    <article class="job-row">
      <div class="job-topline">
        <div><span class="mode-badge">GSC 노출 확인</span><span class="job-id">${escapeHtml(row.snapshot_date || '')}</span></div>
        <strong>평균 ${Number(row.position || 0).toFixed(1)}위</strong>
      </div>
      <h3>${escapeHtml(row.query)}</h3>
      <div class="job-meta">
        <span>${Math.round(Number(row.impressions || 0))} 노출</span>
        <span>${Math.round(Number(row.clicks || 0))} 클릭</span>
        <span>CTR ${(Number(row.ctr || 0) * 100).toFixed(1)}%</span>
        <span>${escapeHtml(rankChange(row))}</span>
      </div>
      <p class="hint">${escapeHtml(shortUrl(row.page))}</p>
    </article>`).join('');
}

export async function loadTrendInsights() {
  ensurePanel();
  const state = document.querySelector('#trend-keyword-state');
  if (!isAdminConnected()) {
    if (state) { state.textContent = '관리 연결 필요'; state.className = 'status-pill neutral'; }
    return;
  }
  if (state) { state.textContent = '불러오는 중'; state.className = 'status-pill active'; }
  try {
    const [trends, rankings] = await Promise.all([
      adminApi('/api/strategy/trends?limit=80'),
      adminApi('/api/strategy/rankings?limit=160')
    ]);
    const trendRows = Array.isArray(trends?.rows) ? trends.rows : [];
    const rankingRows = Array.isArray(rankings?.rows) ? rankings.rows : [];
    renderTrends(trendRows);
    renderRankings(rankingRows);
    const summary = document.querySelector('#trend-keyword-summary');
    const trendNew = trendRows.filter((row) => row.decision === 'new_article').length;
    const trendRepair = trendRows.filter((row) => row.decision === 'repair_existing').length;
    const top10 = Number(rankings?.summary?.top10 || 0);
    if (summary) summary.innerHTML = `
      <div><strong>${trendNew}</strong><span>TREND 신규 후보</span></div>
      <div><strong>${trendRepair}</strong><span>업데이트 후보</span></div>
      <div><strong>${rankingRows.length}</strong><span>노출 검색어</span></div>
      <div><strong>${top10}</strong><span>평균 TOP 10</span></div>`;
    if (state) { state.textContent = '연결됨'; state.className = 'status-pill success'; }
  } catch (error) {
    if (state) { state.textContent = `조회 실패 · ${error.message}`; state.className = 'status-pill danger'; }
  }
}

function bindPanel() {
  const panel = ensurePanel();
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  panel.querySelector('#refresh-trend-keywords')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '수집 중';
    try {
      await adminApi('/api/strategy/trends/refresh', { method: 'POST', body: '{}' });
      await loadTrendInsights();
    } finally {
      button.disabled = false;
      button.textContent = '트렌드 수집';
    }
  });
}

bindPanel();
window.addEventListener('orchestrator:admin-session', loadTrendInsights);
setTimeout(loadTrendInsights, 500);
