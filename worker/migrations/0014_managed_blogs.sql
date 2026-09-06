CREATE TABLE IF NOT EXISTS managed_blogs (
  blog_id TEXT PRIMARY KEY,
  blog_name TEXT,
  blog_url TEXT,
  language TEXT,
  posts_total INTEGER,
  source TEXT NOT NULL DEFAULT 'blogger_api',
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_managed_blogs_status_seen
  ON managed_blogs (status, last_seen_at DESC);
