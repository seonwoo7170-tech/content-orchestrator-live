import { getGoogleAccessToken } from './google-oauth.js';

const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const MAX_PAGE_SIZE = 500;
const MAX_LIMIT = 500;
const ALLOWED_STATUSES = new Set(['live', 'draft']);

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
    const error = new Error('BLOGGER_PAGE_LIMIT_INVALID');
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
    const error = new Error('BLOGGER_PAGE_STATUS_INVALID');
    error.status = 400;
    throw error;
  }
  return statuses;
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function normalizedPath(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.pathname.replace(/\/$/, '') || '/';
  } catch {
    const text = String(value || '').trim();
    if (!text.startsWith('/')) return null;
    return text.replace(/\/$/, '') || '/';
  }
}

async function googleRequest(env, path, options = {}, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    error.providerStatus = response.status;
    throw error;
  }
  return data || {};
}

function normalizePage(page, requestedStatus) {
  return {
    bloggerPageId: String(page?.id || ''),
    title: String(page?.title || ''),
    url: page?.url || null,
    status: String(page?.status || requestedStatus || '').trim().toLowerCase() || null,
    published: page?.published || null,
    updated: page?.updated || null
  };
}

async function listStatusPages(env, blogId, status, limit, fetchImpl) {
  const pages = [];
  let pageToken = null;
  let moreAvailable = false;

  do {
    const remaining = limit - pages.length;
    if (remaining <= 0) {
      moreAvailable = Boolean(pageToken);
      break;
    }
    const pageSize = Math.min(MAX_PAGE_SIZE, remaining);
    const params = new URLSearchParams({
      fetchBodies: 'false',
      maxResults: String(pageSize),
      status,
      view: 'ADMIN'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages?${params.toString()}`,
      {},
      fetchImpl
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const normalized = normalizePage(item, status);
      if (normalized.bloggerPageId) pages.push(normalized);
      if (pages.length >= limit) break;
    }
    pageToken = data?.nextPageToken ? String(data.nextPageToken) : null;
    moreAvailable = Boolean(pageToken);
  } while (pageToken && pages.length < limit);

  return { pages, truncated: pages.length >= limit && moreAvailable };
}

export async function listPages(env, input = {}, fetchImpl = fetch) {
  const blogId = required(input?.blogId, 'BLOG_ID');
  const limit = normalizedLimit(input?.limit);
  const statuses = normalizedStatuses(input);
  const byId = new Map();
  let truncated = false;

  for (const status of statuses) {
    const listed = await listStatusPages(env, blogId, status, limit, fetchImpl);
    truncated = truncated || listed.truncated;
    for (const page of listed.pages) {
      if (!byId.has(page.bloggerPageId)) byId.set(page.bloggerPageId, page);
    }
  }

  const pages = [...byId.values()];
  pages.sort((a, b) => a.title.localeCompare(b.title));

  return {
    blogId,
    statuses,
    pages,
    count: pages.length,
    truncated
  };
}

async function resolvePageByPath(env, blogId, targetValue, fetchImpl) {
  const targetUrl = normalizedUrl(targetValue);
  const targetPath = normalizedPath(targetValue);
  if (!targetUrl || !targetPath) {
    throw Object.assign(new Error('BLOGGER_PAGE_URL_INVALID'), { status: 400 });
  }

  let page;
  try {
    page = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages/bypath?path=${encodeURIComponent(targetPath)}&view=ADMIN`,
      {},
      fetchImpl
    );
  } catch (error) {
    if (String(error?.message || '') === 'BLOGGER_API_404') {
      throw Object.assign(new Error('BLOGGER_PAGE_URL_NOT_FOUND'), { status: 404, cause: error });
    }
    throw error;
  }

  const resolvedPath = normalizedPath(page?.url);
  if (!page?.id || !resolvedPath || resolvedPath !== targetPath) {
    throw Object.assign(new Error('BLOGGER_PAGE_URL_MISMATCH'), {
      status: 502,
      requestedPath: targetPath,
      resolvedPath
    });
  }
  return page;
}

async function resolvePage(env, blogId, input, fetchImpl) {
  const requestedId = String(input?.bloggerPageId || '').trim();
  const targetValue = String(input?.targetUrl || input?.url || '').trim();
  if (requestedId) {
    try {
      return await googleRequest(env, `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(requestedId)}?view=ADMIN`, {}, fetchImpl);
    } catch (error) {
      if (String(error?.message || '') !== 'BLOGGER_API_404' || !targetValue) throw error;
      return resolvePageByPath(env, blogId, targetValue, fetchImpl);
    }
  }

  if (!targetValue) throw Object.assign(new Error('BLOGGER_PAGE_ID_REQUIRED'), { status: 400 });
  return resolvePageByPath(env, blogId, targetValue, fetchImpl);
}

export async function getPage(env, input, fetchImpl = fetch) {
  const blogId = required(input?.blogId, 'BLOG_ID');
  const page = await resolvePage(env, blogId, input, fetchImpl);
  const bloggerPageId = String(page?.id || '').trim();
  if (!bloggerPageId) {
    const error = new Error('BLOGGER_PAGE_ID_MISSING');
    error.status = 502;
    throw error;
  }
  const requestedId = String(input?.bloggerPageId || '').trim();
  if (requestedId && bloggerPageId !== requestedId) {
    const error = new Error('BLOGGER_PAGE_ID_MISMATCH');
    error.status = 502;
    throw error;
  }

  return {
    identity: {
      blogId,
      bloggerPageId,
      permalink: page.url || null,
      status: String(page.status || '').trim().toLowerCase() || null
    },
    page: {
      title: String(page.title || ''),
      html: String(page.content || '')
    },
    rawMeta: {
      published: page.published || null,
      updated: page.updated || null,
      url: page.url || null
    }
  };
}

// A required page (privacy policy, about, contact) is meant to exist exactly once per blog.
// Callers should list existing pages by title first and only create when one is missing,
// since Blogger has no natural-key upsert and calling writePage twice creates a duplicate page.
function normalizePageBody(input) {
  const page = input?.page && typeof input.page === 'object' ? input.page : input || {};
  const title = required(page.title ?? input?.title, 'TITLE');
  const content = required(page.html ?? input?.html ?? input?.content, 'HTML');
  return { title, content };
}

export async function writePage(env, input, fetchImpl = fetch) {
  const operation = String(input?.operation || 'create');
  const blogId = required(input?.blogId, 'BLOG_ID');
  const body = normalizePageBody(input);

  if (operation === 'create') {
    if (input?.bloggerPageId) {
      const error = new Error('NEW_PAGE_MUST_NOT_HAVE_EXISTING_PAGE_ID');
      error.status = 400;
      throw error;
    }
    const publishMode = String(input?.publishMode || 'draft').toLowerCase();
    if (!['draft', 'published'].includes(publishMode)) {
      // Unlike posts, Blogger pages have no scheduled-publish concept.
      const error = new Error('BLOGGER_PAGE_PUBLISH_MODE_INVALID');
      error.status = 400;
      throw error;
    }
    const isDraft = publishMode !== 'published';
    const created = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages?isDraft=${isDraft ? 'true' : 'false'}`,
      { method: 'POST', body },
      fetchImpl
    );
    const createdPageId = String(created?.id || '').trim();
    if (!createdPageId) {
      const error = new Error('BLOGGER_PAGE_ID_MISSING');
      error.status = 502;
      throw error;
    }
    return {
      ok: true,
      operation: 'create',
      publishMode,
      blogId,
      bloggerPageId: createdPageId,
      url: created.url || null,
      status: created.status || (isDraft ? 'DRAFT' : 'LIVE'),
      title: created.title || body.title
    };
  }

  if (operation === 'update') {
    const bloggerPageId = required(input?.bloggerPageId, 'BLOGGER_PAGE_ID');
    const page = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(bloggerPageId)}`,
      { method: 'PUT', body: { ...body, id: bloggerPageId, blog: { id: blogId } } },
      fetchImpl
    );
    if (String(page?.id || '') !== bloggerPageId) {
      const error = new Error('BLOGGER_PAGE_ID_CHANGED_DURING_UPDATE');
      error.status = 502;
      throw error;
    }
    return {
      ok: true,
      operation: 'update',
      blogId,
      bloggerPageId,
      url: page.url || null,
      status: page.status || null,
      title: page.title || body.title
    };
  }

  const error = new Error('BLOGGER_OPERATION_INVALID');
  error.status = 400;
  throw error;
}
