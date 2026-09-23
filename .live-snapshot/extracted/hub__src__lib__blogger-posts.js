// src/lib/blogger-posts.js
var BLOGGER_API2 = "https://www.googleapis.com/blogger/v3";
var MAX_PAGE_SIZE = 500;
var MAX_LIMIT = 2e3;
var ALLOWED_STATUSES = /* @__PURE__ */ new Set(["live", "scheduled", "draft"]);
function required6(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}
__name(required6, "required");
function normalizedLimit(value) {
  if (value === void 0 || value === null || value === "") return MAX_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    const error = new Error("BLOGGER_POST_LIMIT_INVALID");
    error.status = 400;
    throw error;
  }
  return limit;
}
__name(normalizedLimit, "normalizedLimit");
function normalizedStatuses(input = {}) {
  const raw = Array.isArray(input?.statuses) ? input.statuses : input?.status ? [input.status] : ["live"];
  const statuses = [...new Set(raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  if (!statuses.length || statuses.some((value) => !ALLOWED_STATUSES.has(value))) {
    const error = new Error("BLOGGER_POST_STATUS_INVALID");
    error.status = 400;
    throw error;
  }
  return statuses;
}
__name(normalizedStatuses, "normalizedStatuses");
async function googleRequest2(env, path, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API2}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}
__name(googleRequest2, "googleRequest");
function normalizePost(post, requestedStatus) {
  return {
    bloggerPostId: String(post?.id || ""),
    title: String(post?.title || ""),
    url: post?.url || null,
    status: String(post?.status || requestedStatus || "").trim().toLowerCase() || null,
    published: post?.published || null,
    updated: post?.updated || null,
    labels: Array.isArray(post?.labels) ? post.labels.map(String) : []
  };
}
__name(normalizePost, "normalizePost");
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
      fetchBodies: "false",
      maxResults: String(pageSize),
      status,
      view: "ADMIN",
      orderBy: status === "live" ? "published" : "updated"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleRequest2(
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
__name(listStatusPosts, "listStatusPosts");
async function listPosts(env, input = {}, fetchImpl = fetch) {
  const blogId = required6(input?.blogId, "BLOG_ID");
  const limit = normalizedLimit(input?.limit);
  const statuses = normalizedStatuses(input);
  const byId = /* @__PURE__ */ new Map();
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
    const left = Date.parse(a.published || a.updated || "") || 0;
    const right = Date.parse(b.published || b.updated || "") || 0;
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
__name(listPosts, "listPosts");
