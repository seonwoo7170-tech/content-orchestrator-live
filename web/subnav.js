import './google-data-health.js';

const topbar = document.querySelector('.app-topbar');
const brand = topbar?.querySelector('.brand-button');
const views = [...document.querySelectorAll('.app-view[data-view]')];
const jobList = document.querySelector('#job-list');
const toast = document.querySelector('#toast');

const viewTitles = {
  home: '홈',
  work: '작업',
  create: '작성',
  blogs: '블로그',
  automation: '자동화',
  settings: '설정'
};

const menus = {
  home: [
    { label: '대시보드', anchor: '.home-stats' },
    { label: '검색 성과', anchor: '#gsc-performance-panel' },
    { label: '구축 단계', anchor: '.compact-panel' }
  ],
  work: [
    { label: '전체 작업', filter: 'all' },
    { label: '이미지 대기', filter: 'image' },
    { label: '재시도 대기', filter: 'retry' },
    { label: '확인 필요', filter: 'review' },
    { label: '오늘 운영 계획', anchor: '#plan-list' }
  ],
  create: [
    { label: '신규 글', anchor: '#new-job-form' },
    { label: '기존글 리페어', anchor: '#repair-job-form' }
  ],
  blogs: [
    { label: '블로그 목록', anchor: '#blog-cards' },
    { label: '자동화 설정', openView: 'automation' }
  ],
  automation: [
    { label: '자동화 개요', anchor: '#automation-host' },
    { label: '블로그 목록', openView: 'blogs' },
    { label: '작업 현황', openView: 'work' }
  ],
  settings: [
    { label: '관리 연결', anchor: '.connection-panel' },
    { label: 'GSC · GA4 연결', anchor: '#google-data-health-panel' },
    { label: '자동화 설정', openView: 'automation' },
    { label: 'AI 연결 진단', action: 'diagnose-ai' }
  ]
};

let currentFilter = 'all';
let drawer = null;
let overlay = null;
let trigger = null;
let filterChip = null;

function currentViewName() {
  return views.find((view) => !view.hidden)?.dataset.view || 'home';
}

function closeDrawer() {
  document.body.classList.remove('subnav-open');
  trigger?.setAttribute('aria-expanded', 'false');
}

function openDrawer() {
  renderMenu();
  document.body.classList.add('subnav-open');
  trigger?.setAttribute('aria-expanded', 'true');
}

function ensureTopbarTrigger() {
  if (!topbar || !brand || trigger) return;
  const left = document.createElement('div');
  left.className = 'topbar-left';
  brand.before(left);
  left.appendChild(brand);

  trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'subnav-trigger';
  trigger.setAttribute('aria-label', '세부 메뉴 열기');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span></span><span></span><span></span>';
  left.prepend(trigger);
  trigger.addEventListener('click', () => {
    if (document.body.classList.contains('subnav-open')) closeDrawer();
    else openDrawer();
  });
}

function ensureDrawer() {
  if (drawer) return;
  overlay = document.createElement('button');
  overlay.type = 'button';
  overlay.className = 'subnav-overlay';
  overlay.setAttribute('aria-label', '세부 메뉴 닫기');
  overlay.addEventListener('click', closeDrawer);

  drawer = document.createElement('aside');
  drawer.className = 'subnav-drawer';
  drawer.setAttribute('aria-label', '세부 메뉴');
  drawer.innerHTML = `
    <div class="subnav-head">
      <div><small>SMILESEON</small><strong data-subnav-title>메뉴</strong></div>
      <button type="button" class="subnav-close" aria-label="닫기">×</button>
    </div>
    <nav class="subnav-list" data-subnav-list></nav>`;
  drawer.querySelector('.subnav-close')?.addEventListener('click', closeDrawer);
  document.body.append(overlay, drawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
}

function openView(name) {
  const control = document.createElement('button');
  control.type = 'button';
  control.hidden = true;
  control.dataset.openView = name;
  document.body.appendChild(control);
  control.click();
  control.remove();
}

function scrollToTarget(selector) {
  const view = views.find((item) => !item.hidden);
  const target = view?.querySelector(selector) || document.querySelector(selector);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function queueFilterLabel(filter) {
  return ({ all: '전체 작업', image: '이미지 대기', retry: '재시도 대기', review: '확인 필요' })[filter] || '전체 작업';
}

function cardMatchesFilter(card, filter) {
  if (filter === 'all') return true;
  const text = String(card?.textContent || '');
  if (filter === 'image') return /이미지\s*(대기|처리|생성|확인|오류)|이미지 처리 중|이미지 확인 필요/.test(text);
  if (filter === 'retry') return /자동 재시도 대기|자동 복구 대기|재시도|retry/i.test(text);
  if (filter === 'review') return /확인 필요|자동 처리 차단|자동완료 중단|실패|중복 발행 위험/.test(text);
  return true;
}

function ensureFilterChip() {
  const panel = jobList?.closest('.panel');
  if (!panel || filterChip) return;
  filterChip = document.createElement('div');
  filterChip.className = 'queue-filter-chip';
  filterChip.hidden = true;
  const summary = panel.querySelector('#queue-summary');
  if (summary) summary.after(filterChip);
  else panel.prepend(filterChip);
}

function applyQueueFilter(filter = currentFilter) {
  currentFilter = filter;
  ensureFilterChip();
  const cards = [...(jobList?.querySelectorAll('.job-row') || [])];
  let visible = 0;
  for (const card of cards) {
    const match = cardMatchesFilter(card, filter);
    const shouldHide = !match;
    if (card.hidden !== shouldHide) card.hidden = shouldHide;
    if (match) visible += 1;
  }
  if (filterChip) {
    filterChip.hidden = filter === 'all';
    filterChip.innerHTML = filter === 'all'
      ? ''
      : `<span>${queueFilterLabel(filter)}</span><strong>${visible}건</strong><button type="button">필터 해제</button>`;
    filterChip.querySelector('button')?.addEventListener('click', () => {
      applyQueueFilter('all');
      renderMenu();
    }, { once: true });
  }
}

function fixLegacyProgressCopy() {
  for (const node of document.querySelectorAll('.job-live-current,.job-live-next')) {
    const text = String(node.textContent || '');
    const next = text
      .replace('5분 이미지 작업기가 썸네일/본문 이미지 생성', '3분 watchdog이 KIE 이미지 처리를 시작하고 완료 후 10초 간격으로 다음 이미지 생성')
      .replace('다음 5분 복구 틱에서 재작성', '다음 3분 watchdog에서 재작성')
      .replace('5분 복구기가 기존 Post ID를 다시 읽어 확인한 뒤 DONE 판정', '3분 watchdog이 기존 Post ID를 다시 읽어 확인한 뒤 DONE 판정');
    if (next !== text) node.textContent = next;
  }
}

function syncDetailClasses() {
  for (const card of jobList?.querySelectorAll('.job-row') || []) {
    const detail = card.querySelector('.readable-job-details,.job-details');
    card.classList.toggle('detail-open', Boolean(detail && !detail.hidden));
  }
}

function runAction(action) {
  if (action === 'diagnose-ai') {
    const button = document.querySelector('#diagnose-ai');
    if (button) button.click();
    else if (toast) {
      toast.textContent = 'AI 진단 버튼을 찾지 못했습니다.';
      toast.dataset.tone = 'danger';
      toast.classList.add('visible');
    }
  }
}

function renderMenu() {
  ensureDrawer();
  const name = currentViewName();
  const title = drawer?.querySelector('[data-subnav-title]');
  const list = drawer?.querySelector('[data-subnav-list]');
  if (title) title.textContent = viewTitles[name] || '메뉴';
  if (!list) return;
  list.innerHTML = '';
  for (const item of menus[name] || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.filter && item.filter === currentFilter) button.classList.add('active');
    button.addEventListener('click', () => {
      if (item.filter) applyQueueFilter(item.filter);
      if (item.openView) openView(item.openView);
      if (item.anchor) scrollToTarget(item.anchor);
      if (item.action) runAction(item.action);
      closeDrawer();
      renderMenu();
    });
    list.appendChild(button);
  }
}

function watchViews() {
  const observer = new MutationObserver(() => {
    renderMenu();
    if (currentViewName() !== 'work') closeDrawer();
  });
  for (const view of views) observer.observe(view, { attributes: true, attributeFilter: ['hidden'] });
}

function watchJobs() {
  if (!jobList) return;
  const observer = new MutationObserver(() => {
    fixLegacyProgressCopy();
    syncDetailClasses();
    applyQueueFilter(currentFilter);
  });
  observer.observe(jobList, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  fixLegacyProgressCopy();
  syncDetailClasses();
}

ensureTopbarTrigger();
ensureDrawer();
ensureFilterChip();
watchViews();
watchJobs();
renderMenu();
applyQueueFilter('all');
