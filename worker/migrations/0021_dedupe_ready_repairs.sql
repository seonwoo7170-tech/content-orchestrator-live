-- Archive superseded unslotted repair jobs before they can update the same Blogger post twice.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY blog_id, blogger_post_id
           ORDER BY datetime(updated_at) DESC, id DESC
         ) AS rn
  FROM jobs
  WHERE mode = 'repair_existing'
    AND status = 'ready'
    AND archived_at IS NULL
    AND daily_slot_id IS NULL
    AND blogger_post_id IS NOT NULL
    AND blogger_post_id <> ''
)
DELETE FROM job_publications
WHERE status = 'scheduled_update'
  AND job_id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY blog_id, blogger_post_id
           ORDER BY datetime(updated_at) DESC, id DESC
         ) AS rn
  FROM jobs
  WHERE mode = 'repair_existing'
    AND status = 'ready'
    AND archived_at IS NULL
    AND daily_slot_id IS NULL
    AND blogger_post_id IS NOT NULL
    AND blogger_post_id <> ''
)
UPDATE jobs
SET archived_at = datetime('now'),
    hold_reason = 'SUPERSEDED_REPAIR_JOB',
    updated_at = datetime('now')
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Only one active repair update may target a Blogger post at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_publications_active_repair_identity
ON job_publications(blog_id, blogger_post_id)
WHERE blogger_post_id IS NOT NULL
  AND blogger_post_id <> ''
  AND status IN ('scheduled_update', 'claimed');
