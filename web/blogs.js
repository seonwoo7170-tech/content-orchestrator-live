import { adminApi, isAdminConnected } from './admin-session.js';
import './automation-shell.js';
import './automation.js';
import './home-live-status.js';

const blogInputs = [...document.querySelectorAll('input[data-blog-input]')];
const blogPickerTriggers = [...document.querySelectorAll('[data-blog-picker-trigger]')];
const blogPickerDialog = document.querySelector('#blog-picker-dialog');
const blogPickerList = document.querySelector('#blog-picker-list');
const blogPickerStatus = document.querySelector('#blog-picker-status');
const blogPickerCloseButtons = [...document.querySelectorAll('[data-blog-picker-close]')];
const blogState = document.querySelector('#blog-state');
const blogCards = document.querySelector('#blog-cards');

let cachedBlogs = [];
let activeBlogInput = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setState(message, tone = 'neutral') {
  if (!blogState) return;
  blogState.textContent = message;
  blogState.className = `status-pill ${tone}`;
}

function languageLabel(language) {
  const value = String(language || '').toLowerCase();
  if (value.startsWith('ko')) return '한국어';
  if (value.startsWith('en')) return 'English';
  return value ? value.toUpperCase() : '미설정';
}

function blogById(blogId) {
  const id = String(blogId || '');
  return cachedBlogs.find((blog) => String(blog.blogId) === id) || null;
}

function triggerForInput(input) {
  return input?.closest('.form-field')?.querySelector('[data-blog-picker-trigger]') || null;
}

function inputForTrigger(trigger) {
  return trigger?.closest('.form-field')?.querySelector('input[data-blog-input]') || null;
}

function syncSubmitState(input) {
  const submit = input?.form?.querySelector('button[type="submit"]');
  if (submit) submit.disabled = !String(input.value || '').trim();
}

function syncPickerField(input) {
  const trigger = triggerForInput(input);
  if (!trigger) return;
  const name = trigger.querySelector('[data-blog-picker-name]');
  const meta = trigger.querySelector('[data-blog-picker-meta]');
  const blog = blogById(input.value);

  if (blog) {
    if (name) name.textContent = blog.name || `Blog ${blog.blogId}`;
    if (meta) meta.textContent = blog.url || `Blogger ID ${blog.blogId}`;
    trigger.classList.add('is-selected');
  } else {
    input.value = '';
    if (name) name.textContent = '블로그 선택';
    if (meta) meta.textContent = isAdminConnected()
      ? '연결된 Blogger 블로그에서 선택'
      : '관리 연결 후 선택할 수 있습니다';
    trigger.classList.remove('is-selected');
  }
  syncSubmitState(input);
}

function syncAllPickerFields() {
  for (const input of blogInputs) syncPickerField(input);
}

function renderCards(blogs) {
  if (!blogCards) return;
  if (!blogs.length) {
    blogCards.innerHTML = '<p class="muted">연결된 Blogger 블로그가 없습니다.</p>';
    return;
  }
  blogCards.innerHTML = blogs.map((blog) => `
    <button class="blog-app-card" type="button" data-open-view="automation" data-blog-id="${escapeHtml(blog.blogId)}">
      <span class="blog-app-card-main">
        <strong>${escapeHtml(blog.name)}</strong>
        <small>${escapeHtml(blog.url || blog.blogId)}</small>
      </span>
      <span class="blog-app-card-meta">
        <span>${escapeHtml(languageLabel(blog.language))}</span>
        ${blog.postsTotal === null || blog.postsTotal === undefined ? '' : `<span>${escapeHtml(blog.postsTotal)} posts</span>`}
        <b>›</b>
      </span>
    </button>`).join('');
}

function renderPicker() {
  if (!blogPickerList || !blogPickerStatus) return;

  if (!isAdminConnected()) {
    blogPickerStatus.textContent = '먼저 관리 연결을 해주세요.';
    blogPickerList.innerHTML = '<div class="blog-picker-empty">설정에서 관리 연결을 완료하면 연결된 Blogger 블로그가 여기에 표시됩니다.</div>';
    return;
  }

  if (!cachedBlogs.length) {
    blogPickerStatus.textContent = '선택할 수 있는 블로그가 없습니다.';
    blogPickerList.innerHTML = '<div class="blog-picker-empty">연결된 Blogger 블로그 목록을 불러오지 못했거나 등록된 블로그가 없습니다.</div>';
    return;
  }

  blogPickerStatus.textContent = `연결된 블로그 ${cachedBlogs.length}개 · 하나를 선택하세요.`;
  const currentId = String(activeBlogInput?.value || '');
  blogPickerList.innerHTML = cachedBlogs.map((blog) => {
    const selected = String(blog.blogId) === currentId;
    return `
      <button class="blog-picker-option ${selected ? 'is-selected' : ''}" type="button" data-blog-choice="${escapeHtml(blog.blogId)}">
        <span class="blog-picker-option-main">
          <strong>${escapeHtml(blog.name || `Blog ${blog.blogId}`)}</strong>
          <small>${escapeHtml(blog.url || `Blogger ID ${blog.blogId}`)}</small>
        </span>
        <span class="blog-picker-option-meta">
          <span>${escapeHtml(languageLabel(blog.language))}</span>
          ${selected ? '<b class="blog-picker-check">✓</b>' : ''}
        </span>
      </button>`;
  }).join('');
}

function openBlogPicker(trigger) {
  activeBlogInput = inputForTrigger(trigger);
  if (!activeBlogInput || !blogPickerDialog) return;
  renderPicker();
  if (typeof blogPickerDialog.showModal === 'function') blogPickerDialog.showModal();
  else blogPickerDialog.setAttribute('open', '');
}

function closeBlogPicker() {
  if (!blogPickerDialog) return;
  if (typeof blogPickerDialog.close === 'function' && blogPickerDialog.open) blogPickerDialog.close();
  else blogPickerDialog.removeAttribute('open');
}

for (const trigger of blogPickerTriggers) {
  trigger.addEventListener('click', () => openBlogPicker(trigger));
}

for (const button of blogPickerCloseButtons) button.addEventListener('click', closeBlogPicker);

blogPickerDialog?.addEventListener('click', (event) => {
  if (event.target === blogPickerDialog) closeBlogPicker();
});

blogPickerList?.addEventListener('click', (event) => {
  const option = event.target.closest('[data-blog-choice]');
  if (!option || !activeBlogInput) return;
  const blog = blogById(option.dataset.blogChoice);
  if (!blog) return;
  activeBlogInput.value = String(blog.blogId);
  activeBlogInput.dispatchEvent(new Event('change', { bubbles: true }));
  syncPickerField(activeBlogInput);
  closeBlogPicker();
});

document.addEventListener('reset', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  setTimeout(() => {
    for (const input of blogInputs.filter((item) => item.form === form)) syncPickerField(input);
  }, 0);
});

export async function loadBlogs() {
  if (!isAdminConnected()) {
    cachedBlogs = [];
    for (const input of blogInputs) input.value = '';
    syncAllPickerFields();
    renderPicker();
    if (blogCards) blogCards.innerHTML = '<p class="muted">관리 연결 후 블로그 목록을 확인합니다.</p>';
    setState('관리 연결 필요');
    window.dispatchEvent(new CustomEvent('orchestrator:blogs-loaded', { detail: { count: null, blogs: [] } }));
    return;
  }

  setState('불러오는 중', 'active');
  if (blogPickerStatus) blogPickerStatus.textContent = '연결된 블로그를 불러오는 중입니다.';
  try {
    const data = await adminApi('/api/blogs');
    cachedBlogs = Array.isArray(data.blogs) ? data.blogs : [];
    syncAllPickerFields();
    renderPicker();
    renderCards(cachedBlogs);
    setState(`${cachedBlogs.length}개 연결`, cachedBlogs.length ? 'success' : 'neutral');
    window.dispatchEvent(new CustomEvent('orchestrator:blogs-loaded', { detail: { count: cachedBlogs.length, blogs: cachedBlogs } }));
  } catch {
    cachedBlogs = [];
    for (const input of blogInputs) input.value = '';
    syncAllPickerFields();
    renderPicker();
    setState('목록 연결 대기', 'neutral');
    if (blogCards) blogCards.innerHTML = '<p class="muted">블로그 목록을 불러오지 못했습니다.</p>';
    window.dispatchEvent(new CustomEvent('orchestrator:blogs-loaded', { detail: { count: null, blogs: [] } }));
  }
}

window.addEventListener('orchestrator:admin-session', loadBlogs);
loadBlogs();