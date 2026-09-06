CREATE TABLE IF NOT EXISTS daily_blog_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  blog_id TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  diagnosis_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_date, blog_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_blog_diagnostics_date
  ON daily_blog_diagnostics(plan_date, severity, blog_id);
