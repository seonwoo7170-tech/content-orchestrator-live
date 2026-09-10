-- One-time production recovery for the 2026-09-10 daily plan.
-- Only revive the exact slots that were left skipped without a job or recovery reason.
UPDATE daily_plan_slots
SET status = 'pending',
    retry_count = 0,
    recovery_state = 'none',
    next_retry_at = NULL,
    hold_reason = NULL,
    last_error_code = NULL,
    last_failure_at = NULL,
    updated_at = datetime('now')
WHERE plan_date = '2026-09-10'
  AND id IN (
    6923, 6924, 6925, 6926,
    6927, 6928, 6929, 6930,
    6931, 6932, 6933, 6934,
    6935, 6936, 6937, 6938
  )
  AND status = 'skipped'
  AND job_id IS NULL
  AND recovery_state = 'none'
  AND last_error_code IS NULL;
