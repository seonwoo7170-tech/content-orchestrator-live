ALTER TABLE daily_plan_slots ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS daily_blog_workload_decisions (
  plan_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  blog_name TEXT,
  operation_mode TEXT NOT NULL,
  priority_score INTEGER NOT NULL CHECK (priority_score >= 0 AND priority_score <= 100),
  priority_label TEXT NOT NULL,
  new_articles INTEGER NOT NULL CHECK (new_articles >= 0 AND new_articles <= 10),
  repairs INTEGER NOT NULL CHECK (repairs >= 0 AND repairs <= 10),
  signals_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_date, blog_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_priority
ON daily_plan_slots(plan_date, status, priority_score DESC, blog_id, kind, slot_no);

CREATE INDEX IF NOT EXISTS idx_daily_workload_priority
ON daily_blog_workload_decisions(plan_date, priority_score DESC, blog_id);
