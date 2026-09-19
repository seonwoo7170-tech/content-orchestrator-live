import { adminApi, adminSessionReady, isAdminConnected } from './admin-session.js';

const KST = 'Asia/Seoul';
const categoryMeta = {
  scheduled: { label: '예약 완료', icon: '◷' },
  published: { label: '발행 완료', icon: '✓' },
  repair: { label: '리페어 완료', icon: '↻' }
};
let cachedItems = [];
let activeCategory = null;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseUtc(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function kstDateKey(value = new Date()) {
  const date = value instanceof Date ? value : parseUtc(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shortDate() {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: KST, month: 'numeric', day: 'numeric' }).format(new Date());
}

function timeText(value) {
  const date = value instanceof Date ? value : parseUtc(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function parseResult(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

function ensureStyle() {
  if (document.querySelector('#today-completions-style')) return;
  const style = document.createElement('style');
  style.id = 'today-completions-style';
  style.textContent = `
    .today-completions{margin:14px 0 18px;padding-top:14px;border-top:1px solid rgba(148,163,184,.18)}
    .today-completions-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:10px}
    .today-completions-head p{margin:0;color:#7dd3fc;font-size:11px;font-weight:800;letter-spacing:.12em}
    .today-completions-head h3{margin:3px 0 0;font-size:16px;color:#f8fafc}
    .today-completions-head span{color:#94a3b8;font-size:12px}
    .today-completion-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .today-completion-stat{appearance:none;border:1px solid rgba(96,165,250,.22);border-radius:13px;background:#0d1729;color:#e2e8f0;padding:11px 6px;min-width:0;cursor:pointer}
    .today-completion-stat strong{display:block;font-size:19px;line-height:1.1;color:#f8fafc}
    .today-completion-stat span{display:block;margin-top:5px;font-size:11px;color:#94a3b8;white-space:nowrap}
    .today-completion-stat.active{border-color:#3b82f6;background:#10234b;box-shadow:0 0 0 1px rgba(59,130,246,.2) inset}
    .today-completion-list{margin-top:10px;border:1px solid rgba(148,163,184,.16);border-radius:13px;overflow:hidden;background:#091322}
    .today-completion-row{display:grid;grid-template-columns:54px minmax(0,1fr);gap:9px;padding:10px 11px;border-top:1px solid rgba(148,163,184,.12);text-decoration:none;color:inherit}
    .today-completion-row:first-child{border-top:0}
    .today-completion-time{color:#7dd3fc;font-size:12px;font-weight:700;padding-top:2px}
    .today-completion-copy{min-width:0}
    .today-completion-copy strong{display:block;color:#e5edf8;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .today-completion-copy small{display:block;color:#8291a7;font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .today-completion-empty{margin:0;padding:12px;color:#8291a7;font-size:12px;text-align:center}
    @media (max-width:420px){.today-completion-stat{padding:10px 4px}.today-completion-stat strong{font-size:18px}.today-completion-stat span{font-size:10px}}
  `;
  document.head.append(style);
}

function ensureHost() {
  ensureStyle();
  let host = document.querySelector('#today-completions');
  if (host) return host;
  const queueSummary = document.querySelector('#queue-summary');
  if (!queueSummary) return null;
  host = document.createElement('section');
  host.id = 'today-completions';
  host.className = 'today-completions';
  host.setAttribute('aria-live', 'polite');
  queueSummary.insertAdjacentElement('afterend', host);
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-completion-category]');
    if (!button) return;
    const category = button.dataset.completionCategory;
    activeCategory = activeCategory === category ? null : category;
    render(cachedItems);
  });
  return host;
}

function publicationCategory(job, result) {
  if (job.mode === 'repair_existing') return 'repair';
  const publication = result?.publication || {};
  const mode = String(publication.mode || publication.publishMode || '').toLowerCase();
  if (mode === 'published' || mode === 'live') return 'published';
  const scheduled = parseUtc(publication.scheduledAt || publication.scheduled_at || publication.publishedAt || publication.published_at);
  if (scheduled && scheduled.getTime() <= Date.now()) return 'published';
  return 'scheduled';
}

function completionItem(job, result, blogNames) {
  const publication = result?.publication || {};
  const category = publicationCategory(job, result);
  const scheduledAt = publication.scheduledAt || publication.scheduled_at || publication.publishedAt || publication.published_at || null;
  const displayAt = category === 'repair'
    ? (publication.updatedAt || job.updated_at)
    : (scheduledAt || job.updated_at);
  return {
    id: Number(job.id),
    category,
    title: result?.article?.title || job.topic || job.target_url || `작업 #${job.id}`,
    blog: blogNames.get(String(job.blog_id)) || `Blog ${job.blog_id || '-'}`,
    url: publication.url || result?.identity?.permalink || job.target_url || '',
    displayAt,
    completedAt: job.updated_at
  };
}

function render(items = []) {
  const host = ensureHost();
  if (!host) return;
  const counts = { scheduled: 0, published: 0, repair: 0 };
  for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
  const total = items.length;
  const buttons = Object.entries(categoryMeta).map(([key, meta]) => `
    <button type="button" class="today-completion-stat ${activeCategory === key ? 'active' : ''}" data-completion-category="${key}">
      <strong>${counts[key] || 0}</strong><span>${meta.label}</span>
    </button>`).join('');
  const filtered = activeCategory ? items.filter((item) => item.category === activeCategory) : [];
  const rows = filtered.length ? filtered.map((item) => {
    const meta = categoryMeta[item.category];
    const inner = `<span class="today-completion-time">${esc(timeText(item.displayAt))}</span><span class="today-completion-copy"><strong>${esc(item.title)}</strong><small>${esc(meta.label)} · ${esc(item.blog)}</small></span>`;
    return item.url
      ? `<a class="today-completion-row" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<div class="today-completion-row">${inner}</div>`;
  }).join('') : (activeCategory ? '<p class="today-completion-empty">오늘 해당 완료 작업이 없습니다.</p>' : '');
  host.innerHTML = `
    <div class="today-completions-head"><div><p>TODAY DONE</p><h3>오늘 완료</h3></div><span>${esc(shortDate())} · 총 ${total}건</span></div>
    <div class="today-completion-stats">${buttons}</div>
    ${activeCategory ? `<div class="today-completion-list">${rows}</div>` : ''}`;
}

async function mapLimit(rows, limit, fn) {
  const results = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      try { results[index] = await fn(rows[index]); } catch { results[index] = null; }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

export async function loadTodayCompletions() {
  const host = ensureHost();
  if (!host) return;
  if (!isAdminConnected()) {
    cachedItems = [];
    activeCategory = null;
    host.innerHTML = '<p class="today-completion-empty">관리 연결 후 오늘 완료 작업을 확인합니다.</p>';
    return;
  }
  host.innerHTML = '<p class="today-completion-empty">오늘 완료 작업을 불러오는 중입니다.</p>';
  try {
    const [jobsData, blogsData] = await Promise.all([
      adminApi('/api/jobs?status=completed&limit=100'),
      adminApi('/api/blogs').catch(() => ({ blogs: [] }))
    ]);
    const today = kstDateKey();
    const jobs = (jobsData.jobs || []).filter((job) => kstDateKey(job.updated_at || job.created_at) === today);
    const blogNames = new Map((blogsData.blogs || []).map((blog) => [String(blog.blogId), blog.name || blog.title || `Blog ${blog.blogId}`]));
    const details = await mapLimit(jobs.slice(0, 60), 6, async (job) => {
      const data = await adminApi(`/api/jobs/${Number(job.id)}`);
      const row = data.job || {};
      const result = parseResult(row.result_json);
      if (!result) return completionItem(job, null, blogNames);
      return completionItem({ ...job, ...row }, result, blogNames);
    });
    cachedItems = details.sort((a, b) => (parseUtc(b.displayAt)?.getTime() || 0) - (parseUtc(a.displayAt)?.getTime() || 0));
    render(cachedItems);
  } catch (error) {
    host.innerHTML = `<p class="today-completion-empty">오늘 완료 조회 실패: ${esc(error?.message || 'UNKNOWN')}</p>`;
  }
}

window.addEventListener('orchestrator:admin-session', loadTodayCompletions);
window.addEventListener('orchestrator:jobs-changed', loadTodayCompletions);
document.querySelector('#refresh-jobs')?.addEventListener('click', () => setTimeout(loadTodayCompletions, 0));
setInterval(() => { if (cachedItems.length) { cachedItems = cachedItems.map((item) => ({ ...item, category: item.category === 'repair' ? 'repair' : ((parseUtc(item.displayAt)?.getTime() || Infinity) <= Date.now() ? 'published' : 'scheduled') })); render(cachedItems); } }, 60_000);

await adminSessionReady;
loadTodayCompletions();
