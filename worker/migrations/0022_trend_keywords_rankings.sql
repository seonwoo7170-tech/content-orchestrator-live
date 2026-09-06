CREATE TABLE IF NOT EXISTS trend_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo TEXT NOT NULL,
  query TEXT NOT NULL,
  approx_traffic_text TEXT,
  approx_traffic_value INTEGER NOT NULL DEFAULT 0,
  news_count INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(geo, query)
);

CREATE TABLE IF NOT EXISTS trend_candidate_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  blog_id TEXT NOT NULL,
  topic_candidate_id INTEGER,
  relevance_score REAL NOT NULL DEFAULT 0,
  trend_score REAL NOT NULL DEFAULT 0,
  competition_score REAL NOT NULL DEFAULT 0,
  competition_label TEXT NOT NULL DEFAULT 'medium',
  decision TEXT NOT NULL,
  target_page TEXT,
  snapshot_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(signal_id, blog_id)
);

CREATE INDEX IF NOT EXISTS idx_trend_signals_geo_fetched
  ON trend_signals (geo, fetched_at DESC, approx_traffic_value DESC);
CREATE INDEX IF NOT EXISTS idx_trend_matches_blog_date
  ON trend_candidate_matches (blog_id, snapshot_date DESC, trend_score DESC);
CREATE INDEX IF NOT EXISTS idx_trend_matches_candidate
  ON trend_candidate_matches (topic_candidate_id);
