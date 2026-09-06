CREATE TABLE IF NOT EXISTS topic_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  query TEXT NOT NULL,
  intent TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gsc',
  snapshot_date TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  opportunity_score REAL NOT NULL DEFAULT 0,
  target_page TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blog_id, query)
);

CREATE INDEX IF NOT EXISTS idx_topic_candidates_blog_score
  ON topic_candidates (blog_id, opportunity_score DESC, impressions DESC);

CREATE INDEX IF NOT EXISTS idx_topic_candidates_intent_status
  ON topic_candidates (intent, status, opportunity_score DESC);
