import { callHub } from './api-hub.js';
import { normalizeBlogList } from './blog-registry.js';

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

export function isTistoryBlog(blog) {
  const host = hostOf(blog?.url);
  return host === 'tistory.com' || host.endsWith('.tistory.com');
}

export function bloggerOnly(blogs = []) {
  return (Array.isArray(blogs) ? blogs : []).filter((blog) => blog?.blogId && !isTistoryBlog(blog));
}

export async function loadManagedBlogsSnapshot(env, options = {}) {
  const db = options.db || env?.ORCHESTRATOR_DB;
  if (!db) return [];
  const result = await db.prepare(
    `SELECT blog_id, blog_name, blog_url, language, posts_total
       FROM managed_blogs
      WHERE status = 'active'
      ORDER BY blog_id`
  ).all();
  return bloggerOnly((result?.results || []).map((row) => ({
    blogId: String(row.blog_id || ''),
    name: row.blog_name || `Blog ${row.blog_id}`,
    url: row.blog_url || null,
    language: row.language || null,
    postsTotal: row.posts_total == null ? null : Number(row.posts_total)
  })));
}

export async function syncManagedBlogs(env, blogs, options = {}) {
  const normalized = bloggerOnly(blogs);
  const db = options.db || env?.ORCHESTRATOR_DB;
  if (!db) return { synced: false, reason: 'DB_NOT_BOUND', blogCount: normalized.length, newBlogIds: [] };

  const existing = await db.prepare('SELECT blog_id FROM managed_blogs').all();
  const known = new Set((existing?.results || []).map((row) => String(row.blog_id)));
  const newBlogIds = normalized.filter((blog) => !known.has(String(blog.blogId))).map((blog) => String(blog.blogId));

  for (const blog of normalized) {
    await db.prepare(
      `INSERT INTO managed_blogs
        (blog_id, blog_name, blog_url, language, posts_total, source, status, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'blogger_api', 'active', datetime('now'), datetime('now'), datetime('now'))
       ON CONFLICT(blog_id) DO UPDATE SET
         blog_name=excluded.blog_name,
         blog_url=excluded.blog_url,
         language=excluded.language,
         posts_total=excluded.posts_total,
         source='blogger_api',
         last_seen_at=datetime('now'),
         updated_at=datetime('now')`
    ).bind(
      String(blog.blogId),
      blog.name || null,
      blog.url || null,
      blog.language || null,
      blog.postsTotal == null ? null : Number(blog.postsTotal)
    ).run();
  }

  return { synced: true, blogCount: normalized.length, newBlogIds };
}

export async function loadConnectedBlogs(env, options = {}) {
  const callHubFn = options.callHubFn || callHub;
  const data = await callHubFn(
    env,
    env?.HUB_BLOGGER_BLOGS_PATH || '/api/blogger/blogs',
    { action: 'list' }
  );
  const blogs = bloggerOnly(normalizeBlogList(data));
  if (options.sync !== false) await syncManagedBlogs(env, blogs, options);
  return blogs;
}
