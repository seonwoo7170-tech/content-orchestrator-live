ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'none' CHECK (recovery_state IN ('none', 'retry_wait', 'held'));
ALTER TABLE jobs ADD COLUMN next_retry_at TEXT;
ALTER TABLE jobs ADD COLUMN hold_reason TEXT;
ALTER TABLE jobs ADD COLUMN last_error_code TEXT;
ALTER TABLE jobs ADD COLUMN last_failure_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_recovery_due
ON jobs(recovery_state, next_retry_at, id);

CREATE INDEX IF NOT EXISTS idx_jobs_recovery_blog
ON jobs(blog_id, recovery_state, updated_at);
