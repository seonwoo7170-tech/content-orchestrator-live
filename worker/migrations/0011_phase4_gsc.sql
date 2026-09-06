CREATE TABLE IF NOT EXISTS gsc_blog_properties (
  blog_id TEXT PRIMARY KEY,
  blog_name TEXT,
  blog_url TEXT,
  site_url TEXT,
  permission_level TEXT,
  match_type TEXT,
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gsc_snapshots (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  site_url TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  detail_row_count INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, window_days)
);

CREATE TABLE IF NOT EXISTS gsc_query_page_rows (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, query, page)
);

CREATE INDEX IF NOT EXISTS idx_gsc_snapshots_blog_date
  ON gsc_snapshots (blog_id, snapshot_date DESC, window_days);

CREATE INDEX IF NOT EXISTS idx_gsc_query_page_blog_date
  ON gsc_query_page_rows (blog_id, snapshot_date DESC, impressions DESC);
