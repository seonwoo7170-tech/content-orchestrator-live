ALTER TABLE jobs ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_active_queue
ON jobs (archived_at, status, id DESC);

-- Completed work remains available for history/reporting, but leaves the active queue.
UPDATE jobs
SET archived_at = datetime('now')
WHERE archived_at IS NULL
  AND status = 'completed';

-- Old attention items are no longer useful in the active queue after a full day.
UPDATE jobs
SET archived_at = datetime('now')
WHERE archived_at IS NULL
  AND status IN ('failed', 'needs_review')
  AND updated_at < datetime('now', '-1 day');

-- Collapse historical retry/rewrite duplicates while preserving the newest logical job.
UPDATE jobs
SET archived_at = datetime('now')
WHERE archived_at IS NULL
  AND status IN ('failed', 'needs_review')
  AND EXISTS (
    SELECT 1
    FROM jobs AS newer
    WHERE newer.id > jobs.id
      AND newer.mode = jobs.mode
      AND COALESCE(newer.blog_id, '') = COALESCE(jobs.blog_id, '')
      AND COALESCE(newer.blogger_post_id, '') = COALESCE(jobs.blogger_post_id, '')
      AND COALESCE(newer.target_url, '') = COALESCE(jobs.target_url, '')
      AND COALESCE(newer.topic, '') = COALESCE(jobs.topic, '')
  );
