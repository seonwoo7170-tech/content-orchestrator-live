CREATE TABLE IF NOT EXISTS adsense_page_snapshots (
  snapshot_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  page_url TEXT NOT NULL,
  page_path TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  page_views REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  estimated_earnings REAL NOT NULL DEFAULT 0,
  page_views_rpm REAL NOT NULL DEFAULT 0,
  currency_code TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, blog_id, page_url)
);

CREATE INDEX IF NOT EXISTS idx_adsense_page_snapshots_blog_date_earnings
  ON adsense_page_snapshots (blog_id, snapshot_date, estimated_earnings DESC);
