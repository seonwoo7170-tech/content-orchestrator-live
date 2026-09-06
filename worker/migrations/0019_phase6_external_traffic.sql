CREATE TABLE IF NOT EXISTS external_channel_settings (
  blog_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  content_enabled INTEGER NOT NULL DEFAULT 1 CHECK (content_enabled IN (0, 1)),
  delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delivery_enabled IN (0, 1)),
  variants_per_post INTEGER NOT NULL DEFAULT 3 CHECK (variants_per_post BETWEEN 1 AND 5),
  destination_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blog_id, channel)
);

CREATE TABLE IF NOT EXISTS external_content_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  blog_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  variant_no INTEGER NOT NULL CHECK (variant_no BETWEEN 1 AND 5),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  destination_url TEXT NOT NULL,
  tracked_destination_url TEXT NOT NULL,
  tracking_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'claimed', 'published', 'retry_wait', 'held')),
  eligible_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TEXT,
  provider_content_id TEXT,
  error_code TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT,
  UNIQUE(job_id, channel, variant_no)
);

CREATE TABLE IF NOT EXISTS external_click_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  referrer_host TEXT,
  FOREIGN KEY (asset_id) REFERENCES external_content_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_performance_daily (
  asset_id INTEGER NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  outbound_clicks INTEGER NOT NULL DEFAULT 0 CHECK (outbound_clicks >= 0),
  saves INTEGER NOT NULL DEFAULT 0 CHECK (saves >= 0),
  provider_source TEXT NOT NULL DEFAULT 'local',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (asset_id, metric_date),
  FOREIGN KEY (asset_id) REFERENCES external_content_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_external_assets_delivery
  ON external_content_assets(channel, status, eligible_at, next_retry_at, id);
CREATE INDEX IF NOT EXISTS idx_external_assets_blog
  ON external_content_assets(blog_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_clicks_asset_date
  ON external_click_events(asset_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_external_performance_date
  ON external_performance_daily(metric_date, asset_id);
