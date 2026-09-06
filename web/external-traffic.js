import { adminApi, isAdminConnected } from './admin-session.js';

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function ensurePanel() {
  let panel = document.querySelector('#external-traffic-panel');
  if (panel) return panel;
  const host = document.querySelector('#automation-host');
  if (!host) return null;
  panel = document.createElement('section');
  panel.className = 'panel automation-panel';
  panel.id = 'external-traffic-panel';
  panel.innerHTML = `
    <div class="panel-head queue-head">
      <div><p class="section-kicker">PINTEREST AUTOMATION</p><h2>Pinterest 외부유입</h2></div>
      <button id="external-sync" class="button ghost" type="button">외부 콘텐츠 동기화</button>
    </div>
    <div class="panel-head compact-head">
      <p class="hint">발행된 원문을 Pinterest용 Pin으로 변환하고, 블로그별 Pin 수 · Board · 배포 상태 · 유입 성과를 관리합니다. 실제 외부 전송은 서버 안전 게이트가 켜져야 실행됩니다.</p>
      <span id="external-state" class="status-pill neutral">관리 연결 필요</span>
    </div>
    <div id="external-summary" class="queue-summary"></div>
    <details class="phase-entry" open>
      <summary><strong>블로그별 Pinterest 설정</strong><span id="external-setting-count">0</span></summary>
      <div id="external-settings" class="job-list"><p class="muted">설정을 불러오는 중입니다.</p></div>
    </details>
    <details class="phase-entry">
      <summary><strong>Pin 배포 큐</strong><span id="external-asset-count">0</span></summary>
      <div id="external-assets" class="job-list"></div>
    </details>
    <details class="phase-entry">
      <summary><strong>성과 상위 Pin</strong><span id="external-best-count">0</span></summary>
      <div id="external-best" class="job-list"></div>
    </details>`;
  host.appendChild(panel);
  return panel;
}

function statusLabel(status) {
  return ({ ready: '전송 대기', claimed: '전송 중', published: '게시 완료', retry_wait: '재시도 대기', held: '확인 필요' })[status] || status || '-';
}

function renderSettings(rows, overview) {
  const host = document.querySelector('#external-settings');
  const count = document.querySelector('#external-setting-count');
  if (count) count.textContent = String(rows.length);
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<p class="muted">블로그 설정이 아직 없습니다. 외부 콘텐츠 동기화를 실행해 주세요.</p>';
    return;
  }
  host.innerHTML = rows.map((row) => `
    <form class="job-row external-setting-form" data-blog-id="${escapeHtml(row.blog_id)}">
      <div class="job-topline"><div><span class="mode-badge">Pinterest</span><span class="job-id">${escapeHtml(row.blog_id)}</span></div><strong>${row.delivery_enabled ? '전송 ON' : '전송 OFF'}</strong></div>
      <div class="job-meta"><span>콘텐츠 변환 ${row.content_enabled ? 'ON' : 'OFF'}</span><span>핀 ${Number(row.variants_per_post || 3)}개/글</span></div>
      <div class="form-stack" style="margin-top:10px">
        <label><span>콘텐츠 자동 생성</span><input name="contentEnabled" type="checkbox" ${row.content_enabled ? 'checked' : ''}></label>
        <label><span>실제 Pinterest 전송</span><input name="deliveryEnabled" type="checkbox" ${row.delivery_enabled ? 'checked' : ''}></label>
        <label>Pin 개수 / 글<input name="variantsPerPost" type="number" min="1" max="5" value="${Number(row.variants_per_post || 3)}"></label>
        <label>Pinterest Board ID<input name="destinationId" value="${escapeHtml(row.destination_id || '')}" placeholder="Board ID"></label>
        <button class="button small" type="submit">설정 저장</button>
      </div>
      ${!overview.deliveryGateEnabled ? '<p class="hint">서버 외부전송 게이트가 OFF라 저장해도 실제 Pin POST는 실행되지 않습니다.</p>' : ''}
      ${overview.deliveryGateEnabled && !overview.pinterestConfigured ? '<p class="hint">서버 게이트는 ON이지만 Pinterest 토큰 연결이 필요합니다.</p>' : ''}
    </form>`).join('');
}

function renderAssets(rows) {
  const host = document.querySelector('#external-assets');
  const count = document.querySelector('#external-asset-count');
  if (count) count.textContent = String(rows.length);
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<p class="muted">아직 생성된 Pin 콘텐츠가 없습니다.</p>';
    return;
  }
  host.innerHTML = rows.slice(0, 30).map((row) => `
    <article class="job-row">
      <div class="job-topline"><div><span class="mode-badge">Pin #${Number(row.variant_no)}</span><span class="job-id">Job #${Number(row.job_id)}</span></div><strong>${escapeHtml(statusLabel(row.status))}</strong></div>
      <h3>${escapeHtml(row.title)}</h3>
      <div class="job-meta"><span>${Number(row.outbound_clicks || 0)} 추적 클릭</span><span>${Number(row.impressions || 0)} 노출</span><span>${Number(row.saves || 0)} 저장</span></div>
      <p class="hint">eligible ${escapeHtml(row.eligible_at || '-')} · attempt ${Number(row.attempts || 0)}${row.error_code ? ` · ${escapeHtml(row.error_code)}` : ''}</p>
    </article>`).join('');
}

function renderBest(rows) {
  const host = document.querySelector('#external-best');
  const count = document.querySelector('#external-best-count');
  if (count) count.textContent = String(rows.length);
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<p class="muted">아직 비교할 성과가 없습니다.</p>';
    return;
  }
  host.innerHTML = rows.map((row, index) => `
    <article class="job-row">
      <div class="job-topline"><div><span class="job-id">#${index + 1}</span><span class="mode-badge">${escapeHtml(row.channel)}</span></div><strong>${Number(row.outbound_clicks || 0)} 클릭</strong></div>
      <h3>${escapeHtml(row.title)}</h3>
      <div class="job-meta"><span>variant ${Number(row.variant_no)}</span><span>${Number(row.saves || 0)} 저장</span><span>${Number(row.impressions || 0)} 노출</span></div>
    </article>`).join('');
}

export async function loadExternalTraffic() {
  ensurePanel();
  const state = document.querySelector('#external-state');
  if (!isAdminConnected()) {
    if (state) { state.textContent = '관리 연결 필요'; state.className = 'status-pill neutral'; }
    return;
  }
  if (state) { state.textContent = '불러오는 중'; state.className = 'status-pill active'; }
  try {
    const data = await adminApi('/api/external/overview?limit=50');
    renderSettings(Array.isArray(data.settings) ? data.settings : [], data);
    renderAssets(Array.isArray(data.assets) ? data.assets : []);
    renderBest(Array.isArray(data.bestAssets) ? data.bestAssets : []);
    const summary = document.querySelector('#external-summary');
    if (summary) summary.innerHTML = `
      <div><strong>${Number(data.summary?.ready || 0)}</strong><span>전송 대기</span></div>
      <div><strong>${Number(data.summary?.published || 0)}</strong><span>게시 완료</span></div>
      <div><strong>${Number(data.summary?.trackedClicks || 0)}</strong><span>추적 클릭</span></div>
      <div><strong>${Number(data.summary?.waitingForImage || 0)}</strong><span>이미지 대기</span></div>`;
    if (state) {
      state.textContent = data.deliveryGateEnabled
        ? (data.pinterestConfigured ? 'Pinterest 전송 준비됨' : 'Pinterest 토큰 필요')
        : '안전모드 · 외부전송 OFF';
      state.className = data.deliveryGateEnabled && data.pinterestConfigured ? 'status-pill success' : 'status-pill neutral';
    }
  } catch (error) {
    if (state) { state.textContent = `조회 실패 · ${error.message}`; state.className = 'status-pill danger'; }
  }
}

function bind() {
  const panel = ensurePanel();
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  panel.querySelector('#external-sync')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '동기화 중';
    try {
      await adminApi('/api/external/sync', { method: 'POST' });
      await loadExternalTraffic();
    } finally {
      button.disabled = false;
      button.textContent = '외부 콘텐츠 동기화';
    }
  });
  panel.addEventListener('submit', async (event) => {
    const form = event.target.closest('.external-setting-form');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const blogId = form.dataset.blogId;
    await adminApi(`/api/external/settings/${encodeURIComponent(blogId)}/pinterest`, {
      method: 'PUT',
      body: JSON.stringify({
        contentEnabled: data.get('contentEnabled') === 'on',
        deliveryEnabled: data.get('deliveryEnabled') === 'on',
        variantsPerPost: Number(data.get('variantsPerPost') || 3),
        destinationId: data.get('destinationId') || null
      })
    });
    await loadExternalTraffic();
  });
}

bind();
window.addEventListener('orchestrator:admin-session', loadExternalTraffic);
window.addEventListener('orchestrator:automation-section', (event) => {
  if (event.detail?.section === 'pinterest') loadExternalTraffic();
});
setTimeout(loadExternalTraffic, 300);
