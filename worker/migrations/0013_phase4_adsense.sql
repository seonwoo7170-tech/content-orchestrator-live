CREATE TABLE IF NOT EXISTS adsense_blog_domains (
  blog_id TEXT PRIMARY KEY,
  blog_name TEXT,
  blog_url TEXT,
  domain TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adsense_snapshots (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  domain TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  page_views REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  estimated_earnings REAL NOT NULL DEFAULT 0,
  page_views_rpm REAL NOT NULL DEFAULT 0,
  currency_code TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, window_days)
);

CREATE INDEX IF NOT EXISTS idx_adsense_snapshots_blog_date ON adsense_snapshots(blog_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_adsense_snapshots_date_window ON adsense_snapshots(snapshot_date, window_days);
