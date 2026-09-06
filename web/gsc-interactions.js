import './strategy.js';
import './external-traffic.js';
import './trend-insights.js';
import { adminApi, isAdminConnected } from './admin-session.js';
import { loadGscPerformance } from './performance.js';

const cards = document.querySelector('#gsc-blog-cards');
const refresh = document.querySelector('#refresh-gsc');
const state = document.querySelector('#gsc-state');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmt(value, digits = 0) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(Number(value || 0));
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function pos(value) {
  const n = Number(value || 0);
  return n > 0 ? n.toFixed(1) : '-';
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function currentProperties() {
  const data = await adminApi('/api/performance/gsc/today');
  return Array.isArray(data?.properties) ? data.properties : [];
}

async function decorateCards() {
  if (!cards || !isAdminConnected()) return;
  const properties = await currentProperties().catch(() => []);
  const nodes = [...cards.querySelectorAll(':scope > article.card')];
  nodes.forEach((card, index) => {
    const property = properties[index];
    if (!property) return;
    const blogId = String(property.blog_id || '');
    if (!blogId) return;
    card.dataset.gscBlogId = blogId;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${property.blog_name || `Blog ${blogId}`} 상세 성과 보기`);
    card.style.cursor = 'pointer';
    card.title = '눌러서 검색어·글별 상세 성과 보기';
  });
}

function detailRowsHtml(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) return '<p class="muted">이 블로그의 검색어·글별 상세 데이터가 아직 없습니다.</p>';
  return rows.slice(0, 20).map((row, index) => {
    const href = safeUrl(row.page);
    return `<article class="job-row">
      <div class="job-topline"><div><span class="job-id">#${index + 1}</span><span class="mode-badge">검색 상세</span></div><strong>${fmt(row.clicks)} 클릭</strong></div>
      <h3>${escapeHtml(row.query || '(검색어 없음)')}</h3>
      <div class="job-meta"><span>${fmt(row.impressions)} 노출</span><span>CTR ${pct(row.ctr)}</span><span>평균순위 ${pos(row.position)}</span></div>
      ${href ? `<a class="job-result-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">해당 글 열기 ↗</a>` : ''}
    </article>`;
  }).join('');
}

async function toggleBlogDetail(card) {
  const blogId = card?.dataset?.gscBlogId;
  if (!blogId) return;
  let detail = card.querySelector('.gsc-card-detail');
  if (detail) {
    detail.remove();
    card.setAttribute('aria-expanded', 'false');
    return;
  }
  detail = document.createElement('div');
  detail.className = 'gsc-card-detail';
  detail.style.gridColumn = '1 / -1';
  detail.style.marginTop = '12px';
  detail.innerHTML = '<p class="muted">상세 데이터를 불러오는 중입니다.</p>';
  card.appendChild(detail);
  card.setAttribute('aria-expanded', 'true');
  try {
    const data = await adminApi(`/api/performance/gsc/blogs/${encodeURIComponent(blogId)}?limit=20`);
    detail.innerHTML = `<div style="display:grid;gap:8px;margin-top:8px">${detailRowsHtml(data)}</div>`;
  } catch (error) {
    detail.innerHTML = `<p class="job-error">상세 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

async function refreshWithCollection(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  if (!isAdminConnected()) return loadGscPerformance();
  if (refresh) {
    refresh.disabled = true;
    refresh.textContent = '최신화 중';
  }
  if (state) {
    state.textContent = '최신 데이터 수집 중';
    state.className = 'status-pill active';
  }
  try {
    await adminApi('/api/performance/gsc/collect', { method: 'POST' });
  } catch (error) {
    if (state) {
      state.textContent = '일부 수집 실패';
      state.className = 'status-pill danger';
    }
  } finally {
    await loadGscPerformance();
    await decorateCards();
    if (refresh) {
      refresh.disabled = false;
      refresh.textContent = '새로고침';
    }
  }
}

refresh?.addEventListener('click', refreshWithCollection, true);
cards?.addEventListener('click', (event) => {
  if (event.target.closest('a,button')) return;
  const card = event.target.closest('article.card[data-gsc-blog-id]');
  if (card) toggleBlogDetail(card);
});
cards?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('article.card[data-gsc-blog-id]');
  if (!card) return;
  event.preventDefault();
  toggleBlogDetail(card);
});

if (cards) new MutationObserver(() => decorateCards()).observe(cards, { childList: true });
window.addEventListener('orchestrator:admin-session', decorateCards);
setTimeout(decorateCards, 150);

const aiDiagnoseButton = document.querySelector('#diagnose-ai');
let aiDiagnosticsPanel = null;
let aiToastTimer = null;

function aiToast(message, tone = 'normal') {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('visible');
  clearTimeout(aiToastTimer);
  aiToastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
}

function ensureAiDiagnosticsPanel() {
  if (aiDiagnosticsPanel?.isConnected) return aiDiagnosticsPanel;
  aiDiagnosticsPanel = document.createElement('div');
  aiDiagnosticsPanel.id = 'ai-provider-status';
  aiDiagnosticsPanel.style.marginTop = '12px';
  aiDiagnosticsPanel.style.padding = '12px 14px';
  aiDiagnosticsPanel.style.border = '1px solid rgba(148,163,184,.22)';
  aiDiagnosticsPanel.style.borderRadius = '14px';
  aiDiagnosticsPanel.style.display = 'grid';
  aiDiagnosticsPanel.style.gap = '7px';
  aiDiagnosticsPanel.style.fontSize = '14px';
  aiDiagnoseButton?.insertAdjacentElement('afterend', aiDiagnosticsPanel);
  return aiDiagnosticsPanel;
}

function aiStateTone(provider) {
  const stateValue = String(provider?.state || 'unknown');
  if (stateValue === 'available') return '✅';
  if (stateValue === 'standby' || stateValue === 'configured') return '🟢';
  if (stateValue === 'limited') return '🟠';
  if (stateValue === 'disabled' || stateValue === 'unconfigured') return '⚪';
  return '🔴';
}

function providerRow(name, provider) {
  const label = provider?.label || '확인 필요';
  const detail = provider?.code ? ` · ${provider.code}` : '';
  return `<div><strong>${aiStateTone(provider)} ${escapeHtml(name)}</strong> · ${escapeHtml(label)}${escapeHtml(detail)}</div>`;
}

function renderAiDiagnostics(result) {
  const panel = ensureAiDiagnosticsPanel();
  if (!panel) return;
  const providers = result?.providers || {};
  const usable = Boolean(result?.usable ?? result?.ok);
  const active = result?.activeProvider ? ` · 현재 경로 ${result.activeProvider}` : '';
  panel.innerHTML = `
    <div><strong>${usable ? '✅ AI 사용 가능' : '❌ AI 사용 불가'}</strong>${escapeHtml(active)}</div>
    ${providerRow('Gemini', providers.gemini)}
    ${providerRow('Free.ai', providers.freeAi)}
    ${providerRow('Workers AI', providers.workersAi)}
  `;
  panel.dataset.usable = String(usable);
}

async function diagnoseAllAi(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  if (!aiDiagnoseButton) return;
  aiDiagnoseButton.disabled = true;
  aiDiagnoseButton.textContent = 'AI 상태 확인 중';
  const panel = ensureAiDiagnosticsPanel();
  if (panel) panel.innerHTML = '<div class="muted">Gemini · Free.ai · Workers AI를 확인하고 있습니다.</div>';
  try {
    const result = await adminApi('/api/diagnostics/cloudflare-ai', {
      method: 'POST',
      body: JSON.stringify({ scope: 'all' })
    });
    renderAiDiagnostics(result);
    aiToast(result?.usable ?? result?.ok ? 'AI 사용 가능 · 공급자별 상태를 아래에 표시했습니다.' : 'AI 사용 불가 · 공급자 상태를 확인해 주세요.', result?.usable ?? result?.ok ? 'normal' : 'danger');
  } catch (error) {
    const result = error?.data && typeof error.data === 'object' ? error.data : null;
    if (result?.providers) {
      renderAiDiagnostics(result);
      aiToast('현재 모든 AI 경로를 사용할 수 없습니다.', 'danger');
    } else {
      if (panel) panel.innerHTML = `<div class="job-error">AI 상태 확인 실패: ${escapeHtml(error.message)}</div>`;
      aiToast(`AI 상태 확인 실패: ${error.message}`, 'danger');
    }
  } finally {
    aiDiagnoseButton.disabled = false;
    aiDiagnoseButton.textContent = 'AI 상태 확인';
  }
}

if (aiDiagnoseButton) {
  aiDiagnoseButton.textContent = 'AI 상태 확인';
  aiDiagnoseButton.addEventListener('click', diagnoseAllAi, true);
}
