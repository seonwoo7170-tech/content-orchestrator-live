import { adminApi, isAdminConnected } from './admin-session.js';

let panel = null;
let probeButton = null;
let refreshButton = null;
let timer = null;

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

function formatTime(value) {
  if (!value) return '아직 없음';
  const text = String(value);
  const date = new Date(text.endsWith('Z') ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function newestCollectedAt(rows = []) {
  const values = rows.map((row) => row?.collected_at).filter(Boolean).sort();
  return values.at(-1) || null;
}

function summarizeGsc(data) {
  const properties = Array.isArray(data?.properties) ? data.properties : [];
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  const rows7 = snapshots.filter((row) => Number(row.window_days) === 7);
  const mapped = properties.filter((row) => row.site_url && row.match_type !== 'unmapped').length;
  const failed = rows7.filter((row) => row.status === 'failed').length;
  const healthy = rows7.filter((row) => ['ok', 'partial'].includes(String(row.status))).length;
  const clicks = rows7.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
  const impressions = rows7.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const unmappedNames = properties
    .filter((row) => !row.site_url || row.match_type === 'unmapped')
    .map((row) => String(row.blog_name || row.blog_id || '').trim())
    .filter(Boolean);
  let state = 'waiting';
  let label = '데이터 대기';
  if (data?.collectionEnabled !== true) {
    state = 'disabled';
    label = '자동수집 꺼짐';
  } else if (!properties.length) {
    state = 'waiting';
    label = '연결 확인 필요';
  } else if (failed > 0) {
    state = 'error';
    label = '일부 오류';
  } else if (mapped < properties.length) {
    state = 'partial';
    label = `${mapped}/${properties.length} 연결`;
  } else if (healthy > 0) {
    state = 'ok';
    label = '정상';
  } else if (mapped > 0) {
    state = 'waiting';
    label = '연결됨 · 데이터 대기';
  }
  return {
    state, label, mapped, total: properties.length, failed, unmappedNames,
    metric: `${number(clicks)} 클릭 · ${number(impressions)} 노출`,
    collectedAt: newestCollectedAt(snapshots),
    collectionTime: data?.collectionTime || '03:15'
  };
}

function summarizeGa4(data) {
  const properties = Array.isArray(data?.properties) ? data.properties : [];
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  const rows7 = snapshots.filter((row) => Number(row.window_days) === 7);
  const mapped = properties.filter((row) => row.property_id && row.match_type !== 'unmapped').length;
  const failed = rows7.filter((row) => row.status === 'failed').length;
  const healthy = rows7.filter((row) => ['ok', 'partial'].includes(String(row.status))).length;
  const sessions = rows7.reduce((sum, row) => sum + Number(row.sessions || 0), 0);
  const users = rows7.reduce((sum, row) => sum + Number(row.active_users || 0), 0);
  const views = rows7.reduce((sum, row) => sum + Number(row.screen_page_views || 0), 0);
  const unmappedNames = properties
    .filter((row) => !row.property_id || row.match_type === 'unmapped')
    .map((row) => String(row.blog_name || row.blog_id || '').trim())
    .filter(Boolean);
  let state = 'waiting';
  let label = '데이터 대기';
  if (data?.collectionEnabled !== true) {
    state = 'disabled';
    label = '자동수집 꺼짐';
  } else if (!properties.length) {
    state = 'waiting';
    label = '연결 확인 필요';
  } else if (failed > 0) {
    state = 'error';
    label = '일부 오류';
  } else if (mapped < properties.length) {
    state = 'partial';
    label = `${mapped}/${properties.length} 연결`;
  } else if (healthy > 0) {
    state = 'ok';
    label = '정상';
  } else if (mapped > 0) {
    state = 'waiting';
    label = '연결됨 · 데이터 대기';
  }
  return {
    state, label, mapped, total: properties.length, failed, unmappedNames,
    metric: `${number(sessions)} 세션 · ${number(users)} 사용자 · ${number(views)} 조회`,
    collectedAt: newestCollectedAt(snapshots),
    collectionTime: data?.collectionTime || '03:25'
  };
}

function toneOf(state) {
  if (state === 'ok') return 'success';
  if (state === 'error') return 'danger';
  if (state === 'disabled') return 'neutral';
  return 'active';
}

function serviceCard(name, item, note) {
  const coverage = item.unmappedNames?.length
    ? `<small><strong>설정 필요:</strong> ${escapeHtml(item.unmappedNames.join(' · '))}</small>`
    : '<small>모든 연결 블로그가 매핑되었습니다.</small>';
  return `<article class="card ${item.state === 'error' ? 'danger' : ''}">
    <div class="panel-head compact-head" style="margin:0">
      <strong>${escapeHtml(name)}</strong>
      <span class="status-pill ${toneOf(item.state)}">${escapeHtml(item.label)}</span>
    </div>
    <strong>${escapeHtml(item.metric)}</strong>
    <small>매핑 ${number(item.mapped)}/${number(item.total)} · 자동수집 ${escapeHtml(item.collectionTime)}</small>
    <small>마지막 수집 ${escapeHtml(formatTime(item.collectedAt))}${item.failed ? ` · 오류 ${number(item.failed)}건` : ''}</small>
    ${coverage}
    <small>${escapeHtml(note)}</small>
  </article>`;
}

function ensurePanel() {
  if (panel?.isConnected) return panel;
  const settings = document.querySelector('.app-view[data-view="settings"]');
  const connection = settings?.querySelector('.connection-panel');
  if (!settings || !connection) return null;
  panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'google-data-health-panel';
  panel.innerHTML = `
    <div class="panel-head queue-head">
      <div><p class="section-kicker">GOOGLE DATA</p><h2>GSC · GA4 연결 상태</h2></div>
      <div class="actions">
        <button id="probe-google-data" class="button primary" type="button">연결 확인</button>
        <button id="refresh-google-data" class="button ghost" type="button">새로고침</button>
      </div>
    </div>
    <div class="panel-head compact-head">
      <p class="hint">연결 확인은 실제 Google API를 읽어 GSC와 GA4 수집 가능 여부를 검증합니다.</p>
      <span id="google-data-state" class="status-pill neutral">관리 연결 필요</span>
    </div>
    <div id="google-data-cards" class="grid app-health-grid" aria-live="polite">
      <p class="muted">관리 연결 후 Google 데이터 상태를 확인합니다.</p>
    </div>`;
  connection.insertAdjacentElement('afterend', panel);
  probeButton = panel.querySelector('#probe-google-data');
  refreshButton = panel.querySelector('#refresh-google-data');
  probeButton?.addEventListener('click', probeGoogleData);
  refreshButton?.addEventListener('click', loadGoogleDataHealth);
  return panel;
}

function setOverall(message, tone = 'neutral') {
  const node = ensurePanel()?.querySelector('#google-data-state');
  if (!node) return;
  node.textContent = message;
  node.className = `status-pill ${tone}`;
}

function renderHealth(gscData, ga4Data) {
  const host = ensurePanel();
  if (!host) return;
  const gsc = summarizeGsc(gscData);
  const ga4 = summarizeGa4(ga4Data);
  host.querySelector('#google-data-cards').innerHTML = [
    serviceCard('Search Console', gsc, '검색 클릭 · 노출 · CTR · 평균순위'),
    serviceCard('Google Analytics 4', ga4, '세션 · 사용자 · 페이지 조회')
  ].join('');
  const states = [gsc.state, ga4.state];
  if (states.every((value) => value === 'ok')) setOverall('GSC · GA4 정상', 'success');
  else if (states.includes('error')) setOverall('일부 확인 필요', 'danger');
  else if (states.includes('partial')) setOverall('API 정상 · 일부 블로그 설정 필요', 'active');
  else if (states.includes('disabled')) setOverall('자동수집 설정 확인', 'neutral');
  else setOverall('연결됨 · 데이터 확인 중', 'active');
}

export async function loadGoogleDataHealth() {
  const host = ensurePanel();
  if (!host) return;
  if (!isAdminConnected()) {
    setOverall('관리 연결 필요', 'neutral');
    host.querySelector('#google-data-cards').innerHTML = '<p class="muted">관리 연결 후 Google 데이터 상태를 확인합니다.</p>';
    return;
  }
  setOverall('상태 확인 중', 'active');
  try {
    const [gsc, ga4] = await Promise.all([
      adminApi('/api/performance/gsc/today'),
      adminApi('/api/performance/ga4/today')
    ]);
    renderHealth(gsc, ga4);
  } catch (error) {
    setOverall('조회 실패', 'danger');
    host.querySelector('#google-data-cards').innerHTML = `<p class="job-error">Google 데이터 상태 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

async function probeGoogleData() {
  if (!isAdminConnected() || !probeButton) return;
  probeButton.disabled = true;
  if (refreshButton) refreshButton.disabled = true;
  probeButton.textContent = '실제 API 확인 중';
  setOverall('Google API 읽는 중', 'active');
  try {
    const [gsc, ga4] = await Promise.all([
      adminApi('/api/performance/gsc/collect', { method: 'POST' }),
      adminApi('/api/performance/ga4/collect', { method: 'POST' })
    ]);
    await loadGoogleDataHealth();
    const bad = Number(gsc?.failedCount || 0) + Number(ga4?.failedCount || 0);
    const unmapped = Number(gsc?.unmappedCount || 0) + Number(ga4?.unmappedCount || 0);
    if (bad) setOverall(`연결됨 · 오류 ${bad}건`, 'danger');
    else if (unmapped) setOverall(`API 정상 · 설정 필요 ${unmapped}개`, 'active');
    else setOverall('실제 API 읽기 정상', 'success');
  } catch (error) {
    setOverall('연결 확인 실패', 'danger');
    const host = ensurePanel();
    host.querySelector('#google-data-cards').insertAdjacentHTML('afterbegin', `<p class="job-error">실제 Google API 확인 실패: ${escapeHtml(error.message)}</p>`);
  } finally {
    probeButton.disabled = false;
    if (refreshButton) refreshButton.disabled = false;
    probeButton.textContent = '연결 확인';
  }
}

function scheduleRefresh() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (isAdminConnected() && !document.hidden) loadGoogleDataHealth();
  }, 10 * 60 * 1000);
}

ensurePanel();
window.addEventListener('orchestrator:admin-session', loadGoogleDataHealth);
window.addEventListener('orchestrator:blogs-loaded', loadGoogleDataHealth);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isAdminConnected()) loadGoogleDataHealth();
});
scheduleRefresh();
loadGoogleDataHealth();
