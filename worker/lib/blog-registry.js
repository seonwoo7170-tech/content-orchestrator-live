export function normalizeBlogList(data) {
  const raw = Array.isArray(data) ? data : (data?.blogs ?? data?.items ?? data?.result ?? []);
  if (!Array.isArray(raw)) throw new Error('BLOG_LIST_INVALID');

  const seen = new Set();
  return raw.map((item) => {
    const blogId = String(item?.blogId ?? item?.id ?? '').trim();
    const name = String(item?.blogName ?? item?.name ?? item?.title ?? '').trim();
    const url = item?.url ?? item?.blogUrl ?? null;
    const language = String(item?.language ?? item?.locale?.language ?? '').trim().toLowerCase() || null;
    if (!blogId) throw new Error('BLOG_ID_REQUIRED');
    if (seen.has(blogId)) throw new Error('BLOG_ID_DUPLICATE');
    seen.add(blogId);
    return {
      blogId,
      name: name || `Blog ${blogId}`,
      url: url ? String(url) : null,
      language,
      postsTotal: item?.postsTotal ?? item?.posts?.totalItems ?? null
    };
  });
}
