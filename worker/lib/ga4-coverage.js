function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function isTistoryUrl(value) {
  return String(value || '').toLowerCase().includes('tistory.com');
}

export async function listGa4Coverage(env, blogs = []) {
  const db = requireDb(env);
  const managed = (Array.isArray(blogs) ? blogs : [])
    .map((blog) => ({ blogId: String(blog?.blogId || '').trim(), name: blog?.name || null, url: blog?.url || null }))
    .filter((blog) => blog.blogId && !isTistoryUrl(blog.url));

  const result = await db.prepare(
    `SELECT blog_id, property_id, data_stream_id, default_uri, measurement_id, match_type, updated_at
     FROM ga4_blog_properties`
  ).all();
  const byBlog = new Map((result?.results || []).map((row) => [String(row.blog_id), row]));

  const rows = managed.map((blog) => {
    const row = byBlog.get(blog.blogId) || null;
    const configured = Boolean(row?.property_id);
    return {
      ...blog,
      status: configured ? 'configured' : 'unmapped',
      propertyId: configured ? String(row.property_id) : null,
      dataStreamId: row?.data_stream_id ? String(row.data_stream_id) : null,
      defaultUri: row?.default_uri || null,
      measurementId: row?.measurement_id || null,
      matchType: row?.match_type || 'unmapped',
      updatedAt: row?.updated_at || null
    };
  });

  const configuredCount = rows.filter((row) => row.status === 'configured').length;
  return {
    totalCount: rows.length,
    configuredCount,
    unmappedCount: rows.length - configuredCount,
    complete: rows.length > 0 && configuredCount === rows.length,
    rows
  };
}
