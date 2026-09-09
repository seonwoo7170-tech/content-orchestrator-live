import { getGoogleAccessToken } from './google-oauth.js';

const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const MAX_PAGE_SIZE = 500;
const MAX_LIMIT = 2000;
const ALLOWED_STATUSES = new Set(['live', 'scheduled', 'draft']);

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}

function normalizedLimit(value) {
  if (value === undefined || value === null || value === '') return MAX_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    const error = new Error('BLOGGER_POST_LIMIT_INVALID');
    error.status = 400;
    throw error;
  }
  return limit;
}

function normalizedStatuses(input = {}) {
  const raw = Array.isArray(input?.statuses)
    ? input.statuses
    : (input?.status ? [input.status] : ['live']);
  const statuses = [...new Set(raw.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  if (!statuses.length || statuses.some((value) => !ALLOWED_STATUSES.has(value))) {
    const error = new Error('BLOGGER_POST_STATUS_INVALID');
    error.status = 400;
    throw error;
  }
  return statuses;
}

async function googleRequest(env, path, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}

function normalizePost(post, requestedStatus) {
  return {
    bloggerPostId: String(post?.id || ''),
    title: String(post?.title || ''),
    url: post?.url || null,
    status: String(post?.status || requestedStatus || '').trim().toLowerCase() || null,
    published: post?.published || null,
    updated: post?.updated || null,
    labels: Array.isArray(post?.labels) ? post.labels.map(String) : []
  };
}

async function listStatusPosts(env, blogId, status, limit, fetchImpl) {
  const posts = [];
  let pageToken = null;
  let moreAvailable = false;

  do {
    const remaining = limit - posts.length;
    if (remaining <= 0) {
      moreAvailable = Boolean(pageToken);
      break;
    }
    const pageSize = Math.min(MAX_PAGE_SIZE, remaining);
    const params = new URLSearchParams({
      fetchBodies: 'false',
      maxResults: String(pageSize),
      status,
      view: 'ADMIN',
      orderBy: status === 'live' ? 'published' : 'updated'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?${params.toString()}`,
      fetchImpl
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const normalized = normalizePost(item, status);
      if (normalized.bloggerPostId) posts.push(normalized);
      if (posts.length >= limit) break;
    }
    pageToken = data?.nextPageToken ? String(data.nextPageToken) : null;
    moreAvailable = Boolean(pageToken);
  } while (pageToken && posts.length < limit);

  return { posts, truncated: posts.length >= limit && moreAvailable };
}

export async function listPosts(env, input = {}, fetchImpl = fetch) {
  const blogId = required(input?.blogId, 'BLOG_ID');
  const limit = normalizedLimit(input?.limit);
  const statuses = normalizedStatuses(input);
  const byId = new Map();
  let truncated = false;

  for (const status of statuses) {
    const listed = await listStatusPosts(env, blogId, status, limit, fetchImpl);
    truncated = truncated || listed.truncated;
    for (const post of listed.posts) {
      if (!byId.has(post.bloggerPostId)) byId.set(post.bloggerPostId, post);
    }
  }

  const posts = [...byId.values()];
  posts.sort((a, b) => {
    const left = Date.parse(a.published || a.updated || '') || 0;
    const right = Date.parse(b.published || b.updated || '') || 0;
    return left - right || a.bloggerPostId.localeCompare(b.bloggerPostId);
  });

  return {
    blogId,
    statuses,
    posts,
    count: posts.length,
    truncated
  };
}
