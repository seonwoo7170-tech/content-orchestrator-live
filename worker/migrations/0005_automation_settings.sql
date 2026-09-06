PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS automation_settings (
  scope_key TEXT PRIMARY KEY,
  blog_id TEXT,
  inherit_global INTEGER NOT NULL DEFAULT 1 CHECK (inherit_global IN (0, 1)),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_settings_blog
ON automation_settings(blog_id)
WHERE blog_id IS NOT NULL;
