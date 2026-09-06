CREATE TABLE IF NOT EXISTS ga4_blog_properties (
  blog_id TEXT PRIMARY KEY,
  blog_name TEXT,
  blog_url TEXT,
  property_id TEXT,
  property_name TEXT,
  data_stream_id TEXT,
  default_uri TEXT,
  measurement_id TEXT,
  match_type TEXT NOT NULL DEFAULT 'unmapped',
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ga4_snapshots (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  property_id TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  active_users REAL NOT NULL DEFAULT 0,
  total_users REAL NOT NULL DEFAULT 0,
  sessions REAL NOT NULL DEFAULT 0,
  engaged_sessions REAL NOT NULL DEFAULT 0,
  engagement_rate REAL NOT NULL DEFAULT 0,
  average_session_duration REAL NOT NULL DEFAULT 0,
  screen_page_views REAL NOT NULL DEFAULT 0,
  detail_row_count INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, window_days)
);

CREATE TABLE IF NOT EXISTS ga4_landing_source_rows (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  landing_page TEXT NOT NULL,
  source_medium TEXT NOT NULL,
  active_users REAL NOT NULL DEFAULT 0,
  sessions REAL NOT NULL DEFAULT 0,
  engaged_sessions REAL NOT NULL DEFAULT 0,
  engagement_rate REAL NOT NULL DEFAULT 0,
  screen_page_views REAL NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, landing_page, source_medium)
);

CREATE INDEX IF NOT EXISTS idx_ga4_snapshots_blog_date ON ga4_snapshots(blog_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ga4_detail_blog_date ON ga4_landing_source_rows(blog_id, snapshot_date);
