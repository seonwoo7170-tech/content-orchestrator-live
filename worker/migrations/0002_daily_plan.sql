CREATE TABLE IF NOT EXISTS daily_plan_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  blog_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('new_article', 'repair_existing')),
  slot_no INTEGER NOT NULL DEFAULT 1 CHECK (slot_no > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'skipped')),
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_date, blog_id, kind, slot_no)
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_date_status
ON daily_plan_slots(plan_date, status);
