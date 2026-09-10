-- One-time guarded recovery for job #143 after JOB_EXECUTION_ALREADY_CLAIMED.
-- Diagnostics confirmed no publication row exists for this job, so it is safe to retry.
UPDATE jobs
SET status = 'failed',
    error = 'JOB_EXECUTION_ALREADY_CLAIMED',
    retry_count = 0,
    recovery_state = 'retry_wait',
    next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    hold_reason = NULL,
    last_error_code = 'JOB_EXECUTION_ALREADY_CLAIMED',
    last_failure_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    updated_at = datetime('now')
WHERE id = 143
  AND status = 'failed'
  AND recovery_state = 'held'
  AND last_error_code = 'JOB_EXECUTION_ALREADY_CLAIMED'
  AND NOT EXISTS (
    SELECT 1 FROM job_publications WHERE job_id = 143
  );
