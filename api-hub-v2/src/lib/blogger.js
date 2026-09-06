import { getGoogleAccessToken } from './google-oauth.js';

const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const LANGUAGE_SAMPLE_SIZE = 5;

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function existingPostDescription(post, html) {
  const title = stripHtml(post?.title || '');
  if (title) return title.slice(0, 160);
  const text = stripHtml(html);
  if (!text) return 'Existing Blogger post';
  if (text.length <= 160) return text;
  const clipped = text.slice(0, 157);
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary >= 80 ? clipped.slice(0, boundary) : clipped).trim()}...`;
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

export function detectTextLanguage(value) {
  const text = stripHtml(value);
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (hangul < 12 && latin < 30) return null;
  if (hangul >= 12 && hangul >= latin * 0.15) return 'ko';
  if (latin >= 30 && latin > hangul * 3) return 'en';
  if (hangul === latin) return null;
  return hangul > latin ? 'ko' : 'en';
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
  return data;
}

async function detectRecentPostLanguage(env, blogId, fetchImpl = fetch) {
  try {
    const data = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?fetchBodies=true&maxResults=${LANGUAGE_SAMPLE_SIZE}&status=live&view=ADMIN&orderBy=published`,
      {},
      fetchImpl
    );
    const votes = (data?.items || [])
      .map((post) => detectTextLanguage(`${post?.title || ''}\n${post?.content || ''}`))
      .filter(Boolean);
    if (!votes.length) return null;
    const ko = votes.filter((value) => value === 'ko').length;
    const en = votes.filter((value) => value === 'en').length;
    if (ko === en) return null;
    return ko > en ? 'ko' : 'en';
  } catch {
    return null;
  }
}

export async function listBlogs(env, fetchImpl = fetch) {
  const data = await googleRequest(env, '/users/self/blogs?fetchUserInfo=false', {}, fetchImpl);
  const blogs = await Promise.all((data?.items || []).map(async (blog) => {
    const localeLanguage = String(blog.locale?.language || '').trim().toLowerCase() || null;
    const contentLanguage = Number(blog.posts?.totalItems || 0) > 0
      ? await detectRecentPostLanguage(env, String(blog.id), fetchImpl)
      : null;
    return {
      id: String(blog.id),
      blogId: String(blog.id),
      name: String(blog.name || ''),
      blogName: String(blog.name || ''),
      url: blog.url || null,
      language: contentLanguage || localeLanguage,
      postsTotal: blog.posts?.totalItems ?? null,
      updated: blog.updated || null
    };
  }));
  return { blogs, count: blogs.length };
}

async function resolvePostByPath(env, blogId, targetValue, fetchImpl) {
  const targetUrl = normalizedUrl(targetValue);
  const targetPath = normalizedPath(targetValue);
  if (!targetUrl || !targetPath) {
    throw Object.assign(new Error('BLOGGER_POST_URL_INVALID'), { status: 400 });
  }

  let post;
  try {
    post = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts/bypath?path=${encodeURIComponent(targetPath)}&view=ADMIN`,
      {},
      fetchImpl
    );
  } catch (error) {
    if (String(error?.message || '') === 'BLOGGER_API_404') {
      throw Object.assign(new Error('BLOGGER_POST_URL_NOT_FOUND'), { status: 404, cause: error });
    }
    throw error;
  }

  const resolvedPath = normalizedPath(post?.url);
  if (!post?.id || !resolvedPath || resolvedPath !== targetPath) {
    throw Object.assign(new Error('BLOGGER_POST_URL_MISMATCH'), {
      status: 502,
      requestedPath: targetPath,
      resolvedPath
    });
  }
  return post;
}

async function resolvePost(env, blogId, input, fetchImpl) {
  const requestedId = String(input?.bloggerPostId || '').trim();
  const targetValue = String(input?.targetUrl || input?.url || '').trim();
  if (requestedId) {
    try {
      return await googleRequest(env, `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(requestedId)}?view=ADMIN`, {}, fetchImpl);
    } catch (error) {
      if (String(error?.message || '') !== 'BLOGGER_API_404' || !targetValue) throw error;
      return resolvePostByPath(env, blogId, targetValue, fetchImpl);
    }
  }

  if (!targetValue) throw Object.assign(new Error('BLOGGER_POST_ID_REQUIRED'), { status: 400 });
  return resolvePostByPath(env, blogId, targetValue, fetchImpl);
}

export async function getPost(env, input, fetchImpl = fetch) {
  const blogId = required(input?.blogId, 'BLOG_ID');
  const [post, blog] = await Promise.all([
    resolvePost(env, blogId, input, fetchImpl),
    googleRequest(env, `/blogs/${encodeURIComponent(blogId)}`, {}, fetchImpl)
  ]);
  const bloggerPostId = String(post?.id || '').trim();
  if (!bloggerPostId) {
    const error = new Error('BLOGGER_POST_ID_MISSING');
    error.status = 502;
    throw error;
  }
  const requestedId = String(input?.bloggerPostId || '').trim();
  if (requestedId && bloggerPostId !== requestedId) {
    const error = new Error('BLOGGER_POST_ID_MISMATCH');
    error.status = 502;
    throw error;
  }

  const html = String(post.content || '');
  const fallbackDescription = existingPostDescription(post, html);
  const language = String(input?.language || blog?.locale?.language || 'und');

  return {
    identity: {
      blogId,
      bloggerPostId,
      permalink: post.url || null,
      status: post.status || null
    },
    article: {
      title: String(post.title || ''),
      html,
      searchDescription: fallbackDescription,
      labels: Array.isArray(post.labels) ? post.labels : [],
      sources: [],
      language,
      topic: String(post.title || '')
    },
    rawMeta: {
      published: post.published || null,
      updated: post.updated || null,
      url: post.url || null
    }
  };
}

function normalizeArticle(input) {
  const article = input?.article && typeof input.article === 'object' ? input.article : input || {};
  const title = required(article.title ?? input?.title, 'TITLE');
  const content = required(article.html ?? input?.html ?? input?.content, 'HTML');
  const labels = Array.isArray(article.labels ?? input?.labels) ? (article.labels ?? input.labels) : [];
  return { title, content, labels };
}

function normalizePublishDate(value) {
  const text = required(value, 'PUBLISH_DATE');
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error('PUBLISH_DATE_INVALID');
    error.status = 400;
    throw error;
  }
  return date.toISOString();
}

export async function writePost(env, input, fetchImpl = fetch) {
  const operation = String(input?.operation || 'create');
  const blogId = required(input?.blogId, 'BLOG_ID');
  const body = normalizeArticle(input);

  if (operation === 'create') {
    if (input?.bloggerPostId) {
      const error = new Error('NEW_POST_MUST_NOT_HAVE_EXISTING_POST_ID');
      error.status = 400;
      throw error;
    }
    const publishMode = String(input?.publishMode || 'draft').toLowerCase();
    if (!['draft', 'published', 'scheduled'].includes(publishMode)) {
      const error = new Error('BLOGGER_PUBLISH_MODE_INVALID');
      error.status = 400;
      throw error;
    }
    const isDraft = publishMode !== 'published';
    const created = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?isDraft=${isDraft ? 'true' : 'false'}`,
      { method: 'POST', body },
      fetchImpl
    );
    const createdPostId = String(created?.id || '').trim();
    if (!createdPostId) {
      const error = new Error('BLOGGER_POST_ID_MISSING');
      error.status = 502;
      throw error;
    }

    if (publishMode === 'scheduled') {
      const publishDate = normalizePublishDate(input?.publishDate);
      const scheduled = await googleRequest(
        env,
        `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(createdPostId)}/publish?publishDate=${encodeURIComponent(publishDate)}`,
        { method: 'POST' },
        fetchImpl
      );
      if (String(scheduled?.id || '') !== createdPostId) {
        const error = new Error('BLOGGER_POST_ID_CHANGED_DURING_SCHEDULE');
        error.status = 502;
        throw error;
      }
      return {
        ok: true,
        operation: 'create',
        publishMode: 'scheduled',
        publishDate,
        blogId,
        bloggerPostId: createdPostId,
        url: scheduled.url || created.url || null,
        status: scheduled.status || 'SCHEDULED',
        title: scheduled.title || created.title || body.title
      };
    }

    return {
      ok: true,
      operation: 'create',
      publishMode,
      blogId,
      bloggerPostId: createdPostId,
      url: created.url || null,
      status: created.status || (isDraft ? 'DRAFT' : 'LIVE'),
      title: created.title || body.title
    };
  }

  if (operation === 'update') {
    const bloggerPostId = required(input?.bloggerPostId, 'BLOGGER_POST_ID');
    const post = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(bloggerPostId)}`,
      { method: 'PUT', body: { ...body, id: bloggerPostId, blog: { id: blogId } } },
      fetchImpl
    );
    if (String(post?.id || '') !== bloggerPostId) {
      const error = new Error('BLOGGER_POST_ID_CHANGED_DURING_UPDATE');
      error.status = 502;
      throw error;
    }
    return {
      ok: true,
      operation: 'update',
      blogId,
      bloggerPostId,
      url: post.url || null,
      status: post.status || null,
      title: post.title || body.title
    };
  }

  const error = new Error('BLOGGER_OPERATION_INVALID');
  error.status = 400;
  throw error;
}
