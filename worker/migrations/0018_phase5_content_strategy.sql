ALTER TABLE topic_candidates ADD COLUMN claimed_at TEXT;
ALTER TABLE topic_candidates ADD COLUMN claimed_job_id INTEGER;
ALTER TABLE topic_candidates ADD COLUMN origin_idea_id INTEGER;

CREATE TABLE IF NOT EXISTS content_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  label TEXT NOT NULL,
  hub_candidate_id INTEGER,
  member_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blog_id, cluster_key)
);

CREATE TABLE IF NOT EXISTS content_cluster_members (
  cluster_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'spoke',
  similarity REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(cluster_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS internal_link_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  cluster_id INTEGER,
  source_url TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor_text TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'cluster_relevance',
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blog_id, source_url, target_url)
);

CREATE TABLE IF NOT EXISTS content_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  query TEXT NOT NULL,
  primary_page TEXT NOT NULL,
  competing_page TEXT NOT NULL,
  evidence_score REAL NOT NULL DEFAULT 0,
  decision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  snapshot_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blog_id, query, primary_page, competing_page)
);

CREATE TABLE IF NOT EXISTS idea_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blog_id TEXT NOT NULL,
  title TEXT NOT NULL,
  query TEXT NOT NULL,
  intent TEXT NOT NULL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'idea',
  applied_candidate_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_topic_candidates_lifecycle
  ON topic_candidates (blog_id, status, source, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_cluster_blog
  ON content_clusters (blog_id, member_count DESC);
CREATE INDEX IF NOT EXISTS idx_internal_links_blog_status
  ON internal_link_recommendations (blog_id, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_conflicts_blog_status
  ON content_conflicts (blog_id, status, evidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_blog_status
  ON idea_bank (blog_id, status, priority DESC, id DESC);
