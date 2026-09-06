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
  let panel = document.querySelector('#content-strategy-panel');
  if (panel) return panel;
  const gsc = document.querySelector('#gsc-performance-panel');
  const home = document.querySelector('[data-view="home"]');
  if (!home) return null;
  panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'content-strategy-panel';
  panel.innerHTML = `
    <div class="panel-head queue-head">
      <div><p class="section-kicker">CONTENT STRATEGY</p><h2>콘텐츠 전략</h2></div>
      <button id="refresh-content-strategy" class="button ghost" type="button">전략 최신화</button>
    </div>
    <div class="panel-head compact-head">
      <p class="hint">GSC 근거로 주제·클러스터·내부링크·검색 충돌을 정리합니다. 다른 블로그끼리는 연결하지 않습니다.</p>
      <span id="strategy-state" class="status-pill neutral">관리 연결 필요</span>
    </div>
    <div id="strategy-summary" class="queue-summary"></div>
    <details class="phase-entry" open>
      <summary><strong>주제 후보</strong><span id="strategy-topic-count">0</span></summary>
      <div id="strategy-topics" class="job-list"><p class="muted">전략 데이터를 불러오는 중입니다.</p></div>
    </details>
    <details class="phase-entry">
      <summary><strong>클러스터 · 내부링크</strong><span id="strategy-cluster-count">0</span></summary>
      <div id="strategy-clusters" class="job-list"></div>
      <div id="strategy-links" class="job-list"></div>
    </details>
    <details class="phase-entry">
      <summary><strong>중복 · 카니발리제이션</strong><span id="strategy-conflict-count">0</span></summary>
      <div id="strategy-conflicts" class="job-list"></div>
    </details>
    <details class="phase-entry">
      <summary><strong>아이디어뱅크</strong><span id="strategy-idea-count">0</span></summary>
      <form id="strategy-idea-form" class="form-stack" style="margin-top:12px">
        <label>블로그<input name="blogId" data-blog-input list="blog-options" required placeholder="블로그 선택 또는 blogId"></label>
        <label>아이디어 / 검색어<input name="query" required placeholder="예: 원룸 에어컨 냄새 제거"></label>
        <label>메모<textarea name="notes" rows="2" placeholder="선택 입력"></textarea></label>
        <label>우선순위<input name="priority" type="number" min="0" max="100" value="50"></label>
        <button class="button primary" type="submit">아이디어 저장</button>
      </form>
      <div id="strategy-ideas" class="job-list" style="margin-top:12px"></div>
    </details>`;
  if (gsc?.parentNode) gsc.after(panel); else home.appendChild(panel);
  return panel;
}

function renderEmpty(host, text) {
  if (host) host.innerHTML = `<p class="muted">${escapeHtml(text)}</p>`;
}

function renderTopics(rows) {
  const host = document.querySelector('#strategy-topics');
  document.querySelector('#strategy-topic-count').textContent = String(rows.length);
  if (!rows.length) return renderEmpty(host, '아직 주제 후보가 없습니다. GSC 수집 후 전략 최신화를 실행해 주세요.');
  host.innerHTML = rows.slice(0, 15).map((row) => `
    <article class="job-row">
      <div class="job-topline"><div><span class="mode-badge">${escapeHtml(row.intent || 'informational')}</span><span class="job-id">${escapeHtml(row.source || 'gsc')}</span></div><strong>${Number(row.opportunity_score || 0).toFixed(1)}</strong></div>
      <h3>${escapeHtml(row.query)}</h3>
      <div class="job-meta"><span>${Math.round(Number(row.impressions || 0))} 노출</span><span>${Math.round(Number(row.clicks || 0))} 클릭</span><span>상태 ${escapeHtml(row.status || 'candidate')}</span></div>
      ${row.target_page ? `<p class="hint">대상 글: ${escapeHtml(shortUrl(row.target_page))}</p>` : '<p class="hint">신규 주제 후보 · 기존 대상 글 없음</p>'}
    </article>`).join('');
}

function renderClusters(rows) {
  const host = document.querySelector('#strategy-clusters');
  document.querySelector('#strategy-cluster-count').textContent = String(rows.length);
  if (!rows.length) return renderEmpty(host, '아직 생성된 콘텐츠 클러스터가 없습니다.');
  host.innerHTML = rows.slice(0, 12).map((row) => `
    <article class="job-row">
      <div class="job-topline"><span class="mode-badge">클러스터</span><strong>${Number(row.member_count || 0)}개 주제</strong></div>
      <h3>${escapeHtml(row.label)}</h3>
      <p class="hint">같은 블로그 안에서 허브·스포크 관계로 묶였습니다.</p>
    </article>`).join('');
}

function renderLinks(rows) {
  const host = document.querySelector('#strategy-links');
  if (!rows.length) return renderEmpty(host, '추천할 내부링크가 아직 없습니다.');
  host.innerHTML = `<p class="section-kicker" style="margin-top:14px">INTERNAL LINKS · ${rows.length}</p>` + rows.slice(0, 12).map((row) => `
    <article class="job-row">
      <div class="job-topline"><span class="mode-badge">내부링크</span><strong>${Number(row.score || 0).toFixed(1)}</strong></div>
      <h3>${escapeHtml(row.anchor_text || '관련 글')}</h3>
      <div class="job-meta"><span>${escapeHtml(shortUrl(row.source_url))}</span><span>→</span><span>${escapeHtml(shortUrl(row.target_url))}</span></div>
    </article>`).join('');
}

function conflictLabel(decision) {
  return ({
    repair_internal_links: '내부링크 리페어',
    review_merge: '통합 검토',
    review_intent_split: '검색의도 분리 검토'
  })[decision] || decision || '검토';
}

function renderConflicts(rows) {
  const host = document.querySelector('#strategy-conflicts');
  document.querySelector('#strategy-conflict-count').textContent = String(rows.length);
  if (!rows.length) return renderEmpty(host, '현재 GSC 근거에서 뚜렷한 검색어 충돌이 없습니다.');
  host.innerHTML = rows.slice(0, 15).map((row) => `
    <article class="job-row">
      <div class="job-topline"><span class="status-pill ${row.decision === 'review_merge' ? 'danger' : 'active'}">${escapeHtml(conflictLabel(row.decision))}</span><strong>${Number(row.evidence_score || 0).toFixed(1)}</strong></div>
      <h3>${escapeHtml(row.query)}</h3>
      <div class="job-meta"><span>주력: ${escapeHtml(shortUrl(row.primary_page))}</span><span>경쟁: ${escapeHtml(shortUrl(row.competing_page))}</span></div>
      <p class="hint">자동 삭제·병합은 하지 않습니다. 근거만 기록해 리페어 판단에 사용합니다.</p>
    </article>`).join('');
}

function renderIdeas(rows) {
  const host = document.querySelector('#strategy-ideas');
  document.querySelector('#strategy-idea-count').textContent = String(rows.length);
  if (!rows.length) return renderEmpty(host, '저장된 아이디어가 없습니다.');
  host.innerHTML = rows.slice(0, 20).map((row) => `
    <article class="job-row">
      <div class="job-topline"><span class="mode-badge">${escapeHtml(row.intent)}</span><strong>우선 ${Number(row.priority || 0)}</strong></div>
      <h3>${escapeHtml(row.query)}</h3>
      <div class="job-meta"><span>상태 ${escapeHtml(row.status)}</span><span>Blog ${escapeHtml(row.blog_id)}</span></div>
      ${row.notes ? `<p class="hint">${escapeHtml(row.notes)}</p>` : ''}
      ${row.status === 'idea' || row.status === 'review' ? `<button class="button small" type="button" data-apply-idea="${Number(row.id)}">신규 주제 후보로 전환</button>` : ''}
    </article>`).join('');
}

export async function loadContentStrategy() {
  ensurePanel();
  const state = document.querySelector('#strategy-state');
  if (!isAdminConnected()) {
    if (state) { state.textContent = '관리 연결 필요'; state.className = 'status-pill neutral'; }
    return;
  }
  if (state) { state.textContent = '불러오는 중'; state.className = 'status-pill active'; }
  try {
    const [topics, overview] = await Promise.all([
      adminApi('/api/strategy/topic-candidates?limit=50'),
      adminApi('/api/strategy/overview?limit=50')
    ]);
    const topicRows = Array.isArray(topics?.rows) ? topics.rows : [];
    const clusters = Array.isArray(overview?.clusters) ? overview.clusters : [];
    const links = Array.isArray(overview?.internalLinks) ? overview.internalLinks : [];
    const conflicts = Array.isArray(overview?.conflicts) ? overview.conflicts : [];
    const ideas = Array.isArray(overview?.ideas) ? overview.ideas : [];
    renderTopics(topicRows);
    renderClusters(clusters);
    renderLinks(links);
    renderConflicts(conflicts);
    renderIdeas(ideas);
    const summary = document.querySelector('#strategy-summary');
    if (summary) summary.innerHTML = `
      <div><strong>${topicRows.length}</strong><span>주제 후보</span></div>
      <div><strong>${clusters.length}</strong><span>클러스터</span></div>
      <div><strong>${links.length}</strong><span>내부링크</span></div>
      <div><strong>${conflicts.length}</strong><span>충돌 검토</span></div>`;
    if (state) { state.textContent = '전략 연결됨'; state.className = 'status-pill success'; }
  } catch (error) {
    if (state) { state.textContent = `조회 실패 · ${error.message}`; state.className = 'status-pill danger'; }
  }
}

function bindPanel() {
  const panel = ensurePanel();
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  panel.querySelector('#refresh-content-strategy')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '최신화 중';
    try {
      await adminApi('/api/strategy/topic-candidates/refresh', { method: 'POST' });
      await loadContentStrategy();
    } finally {
      button.disabled = false;
      button.textContent = '전략 최신화';
    }
  });
  panel.querySelector('#strategy-idea-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await adminApi('/api/strategy/ideas', {
      method: 'POST',
      body: JSON.stringify({
        blogId: form.get('blogId'),
        query: form.get('query'),
        notes: form.get('notes'),
        priority: Number(form.get('priority') || 50)
      })
    });
    event.currentTarget.reset();
    await loadContentStrategy();
  });
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-apply-idea]');
    if (!button) return;
    button.disabled = true;
    try {
      await adminApi(`/api/strategy/ideas/${encodeURIComponent(button.dataset.applyIdea)}/apply`, { method: 'POST' });
      await loadContentStrategy();
    } finally {
      button.disabled = false;
    }
  });
}

bindPanel();
window.addEventListener('orchestrator:admin-session', loadContentStrategy);
setTimeout(loadContentStrategy, 250);
