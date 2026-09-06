import './external-traffic.js';

const host = document.querySelector('#automation-host');
const STORAGE_KEY = 'smileseon-automation-section';
let selectedSection = 'blog';

try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'pinterest' || stored === 'blog') selectedSection = stored;
} catch { /* ignore */ }

function ensureSubnav() {
  if (!host) return null;
  let nav = host.querySelector('#automation-subnav');
  if (nav) return nav;
  nav = document.createElement('nav');
  nav.id = 'automation-subnav';
  nav.className = 'automation-subnav';
  nav.setAttribute('aria-label', '자동화 세부 메뉴');
  nav.innerHTML = `
    <button type="button" data-automation-section="blog">
      <strong>블로그 자동화</strong>
      <small>글작성 · 리페어 · 이미지 · 예약발행</small>
    </button>
    <button type="button" data-automation-section="pinterest">
      <strong>Pinterest 외부유입</strong>
      <small>Pin 생성 · 스케줄 · Board · 성과 추적</small>
    </button>`;
  host.prepend(nav);
  return nav;
}

function applySection(section = selectedSection) {
  selectedSection = section === 'pinterest' ? 'pinterest' : 'blog';
  const nav = ensureSubnav();
  const blogPanel = host?.querySelector('#automation-panel');
  const pinterestPanel = host?.querySelector('#external-traffic-panel');

  if (blogPanel) blogPanel.hidden = selectedSection !== 'blog';
  if (pinterestPanel) pinterestPanel.hidden = selectedSection !== 'pinterest';

  for (const button of nav?.querySelectorAll('[data-automation-section]') || []) {
    const active = button.dataset.automationSection === selectedSection;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  }

  try { localStorage.setItem(STORAGE_KEY, selectedSection); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('orchestrator:automation-section', { detail: { section: selectedSection } }));
}

const nav = ensureSubnav();
nav?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-automation-section]');
  if (!button) return;
  applySection(button.dataset.automationSection);
});

if (host) {
  new MutationObserver(() => applySection(selectedSection)).observe(host, { childList: true });
}

window.addEventListener('orchestrator:open-blog-automation', () => applySection('blog'));
window.addEventListener('orchestrator:open-pinterest-automation', () => applySection('pinterest'));
window.addEventListener('load', () => applySection(selectedSection));
applySection(selectedSection);
