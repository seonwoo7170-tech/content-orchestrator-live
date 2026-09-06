PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS job_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('thumbnail', 'body')),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0 AND position <= 10),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'generated', 'stored', 'attached', 'failed')),
  prompt TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  mime_type TEXT,
  storage_key TEXT,
  public_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, role, position)
);

CREATE INDEX IF NOT EXISTS idx_job_images_job_status
ON job_images(job_id, status, role, position);
