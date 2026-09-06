PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS job_publications_v2 (
  job_id INTEGER PRIMARY KEY,
  blog_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  slot_no INTEGER NOT NULL CHECK (slot_no > 0),
  scheduled_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'scheduled', 'published', 'scheduled_update', 'updated', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  blogger_post_id TEXT,
  url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO job_publications_v2
  (job_id, blog_id, plan_date, slot_no, scheduled_time, status, attempts, blogger_post_id, url, error, created_at, updated_at)
SELECT job_id, blog_id, plan_date, slot_no, scheduled_time, status, attempts, blogger_post_id, url, error, created_at, updated_at
FROM job_publications;

DROP TABLE job_publications;
ALTER TABLE job_publications_v2 RENAME TO job_publications;

CREATE INDEX IF NOT EXISTS idx_job_publications_day_status
ON job_publications(plan_date, blog_id, status, slot_no);

PRAGMA foreign_keys = ON;
