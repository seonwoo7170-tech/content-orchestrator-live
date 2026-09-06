PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS job_publications (
  job_id INTEGER PRIMARY KEY,
  blog_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  slot_no INTEGER NOT NULL CHECK (slot_no > 0),
  scheduled_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  blogger_post_id TEXT,
  url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_job_publications_day_status
ON job_publications(plan_date, blog_id, status, slot_no);
