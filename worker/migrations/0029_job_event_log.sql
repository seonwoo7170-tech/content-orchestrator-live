CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id_id
  ON job_events(job_id, id);
