import './work-live-progress.js';
import './live-work-progress.js';
import { adminApi, isAdminConnected } from './admin-session.js';

const homeView = document.querySelector('[data-view="home"]');
const cards = homeView ? [...homeView.querySelectorAll('.app-health-grid .card')] : [];
const homeQueued = document.querySelector('#home-queued');
const homeActive = document.querySelector('#home-active');
const homeReady = document.querySelector('#home-ready');
const homeBlogs = document.querySelector('#home-blogs');

function setCard(card, label, value, detail, danger = false) {
  if (!card) return;
  card.classList.toggle('danger', Boolean(danger));
  card.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${detail}</small>`;
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function ensureStamp() {
  let stamp = document.querySelector('#home-live-stamp');
  if (stamp || !homeView) return stamp;
  stamp = document.createElement('p');
  stamp.id = 'home-live-stamp';
  stamp.className = 'hint';
  stamp.style.margin = '8px 4px 16px';
  const grid = homeView.querySelector('.app-health-grid');
  grid?.insertAdjacentElement('beforebegin', stamp);
  return stamp;
}

function summarizeJobs(jobs = []) {
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  const active = ['writing', 'critic_review', 'repairing', 'final_critic', 'updating_existing', 'publishing_new']
    .reduce((sum, key) => sum + (counts[key] || 0), 0);
  const ready = (counts.ready || 0) + (counts.needs_review || 0);
  if (homeQueued) homeQueued.textContent = String(counts.queued || 0);
  if (homeActive) homeActive.textContent = String(active);
  if (homeReady) homeReady.textContent = String(ready);
}

function recoveryCounts(recovery, publications) {
  const jobSummary = recovery?.summary?.jobs || {};
  const retryWait = Number(jobSummary.retryWait || 0);
  const held = Number(jobSummary.held || 0);
  const heldItems = Array.isArray(recovery?.heldItems) ? recovery.heldItems.length : 0;
  const publicationAttention = Number(publications?.attentionRequired || publications?.failed || 0);
  return { retryWait, held: Math.max(held, heldItems), publicationAttention };
}

async function publicHealth() {
  const response = await fetch(`/health?ts=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

export async function refreshHomeLiveStatus() {
  if (!homeView || homeView.hidden || document.hidden) return;
  const stamp = ensureStamp();
  if (stamp) stamp.textContent = '실제 서버 상태 확인 중…';
  try {
    const health = await publicHealth();
    let jobs = [];
    let blogs = [];
    let plan = null;
    let recovery = null;
    let publications = null;
    if (isAdminConnected()) {
      const results = await Promise.allSettled([
        adminApi(`/api/jobs?limit=50&ts=${Date.now()}`),
        adminApi(`/api/blogs?ts=${Date.now()}`),
        adminApi(`/api/operations/today?ts=${Date.now()}`),
        adminApi(`/api/operations/recovery?ts=${Date.now()}`),
        adminApi(`/api/operations/publications/today?ts=${Date.now()}`)
      ]);
      jobs = results[0].status === 'fulfilled' ? (results[0].value.jobs || []) : [];
      blogs = results[1].status === 'fulfilled' ? (results[1].value.blogs || []) : [];
      plan = results[2].status === 'fulfilled' ? results[2].value : null;
      recovery = results[3].status === 'fulfilled' ? results[3].value : null;
      publications = results[4].status === 'fulfilled' ? results[4].value : null;
      summarizeJobs(jobs);
      if (homeBlogs && blogs.length) homeBlogs.textContent = String(blogs.length);
    }

    const autoPublish = Boolean(health?.phase2Automation?.autoPublishExecutionEnabled);
    const writes = Boolean(health?.bloggerWritesEnabled);
    const hub = Boolean(health?.apiHubConfigured);
    const slotCount = Number(plan?.count || 0);
    const planDate = plan?.planDate || '미생성';
    const attention = recoveryCounts(recovery, publications);
    const attentionTotal = attention.retryWait + attention.held + attention.publicationAttention;
    const hardAttention = attention.held + attention.publicationAttention;

    setCard(cards[0], 'API Hub', hub ? '연결됨' : '미연결', '실제 서버 연결 상태', !hub);
    setCard(cards[1], '자동 발행', autoPublish ? 'ON' : 'OFF', '실제 운영 설정', !autoPublish);
    setCard(
      cards[2],
      '운영 상태',
      attentionTotal > 0 ? `주의 ${attentionTotal}` : '정상',
      `재시도 ${attention.retryWait} · 작업보류 ${attention.held} · 발행확인 ${attention.publicationAttention}`,
      hardAttention > 0
    );
    setCard(cards[3], 'Blogger 쓰기', writes ? 'ON' : 'OFF', '실제 운영 설정', !writes);

    if (stamp) stamp.textContent = `마지막 실제 확인 ${formatTime()} · 오늘 계획 ${slotCount}건 (${planDate}) · 60초마다 자동 갱신`;
  } catch (error) {
    setCard(cards[0], '서버 상태', '확인 실패', '연결을 다시 확인해 주세요', true);
    if (stamp) stamp.textContent = `마지막 확인 실패 ${formatTime()} · ${error.message}`;
  }
}

function refreshHomeSoon() {
  setTimeout(() => void refreshHomeLiveStatus(), 50);
}

window.addEventListener('focus', refreshHomeLiveStatus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshHomeLiveStatus();
});
document.addEventListener('click', (event) => {
  const target = event.target?.closest?.('[data-open-view="home"], [data-nav-target="home"]');
  if (target) refreshHomeSoon();
});
window.addEventListener('orchestrator:admin-session', refreshHomeLiveStatus);
window.addEventListener('orchestrator:jobs-changed', refreshHomeLiveStatus);
window.addEventListener('orchestrator:blogs-loaded', refreshHomeLiveStatus);
setInterval(refreshHomeLiveStatus, 60000);
refreshHomeLiveStatus();
