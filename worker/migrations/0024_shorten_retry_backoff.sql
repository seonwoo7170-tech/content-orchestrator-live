-- Align already-persisted retry waits with the shorter recovery policy.
-- Non-quota retry ladder: 1m, 3m, 10m.
-- Quota retry ladder: 30m, 120m, 360m.

UPDATE jobs
SET next_retry_at = CASE
  WHEN retry_count <= 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+1 minute')
  WHEN retry_count = 2 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+3 minutes')
  ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+10 minutes')
END
WHERE status = 'failed'
  AND recovery_state = 'retry_wait'
  AND last_failure_at IS NOT NULL
  AND NOT (
    COALESCE(last_error_code, '') = 'RESOURCE_EXHAUSTED'
    OR COALESCE(last_error_code, '') LIKE '%ACCOUNT_LIMITED%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_ALLOCATION%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_QUOTA%'
  )
  AND julianday(next_retry_at) > julianday(CASE
    WHEN retry_count <= 1 THEN datetime(last_failure_at, '+1 minute')
    WHEN retry_count = 2 THEN datetime(last_failure_at, '+3 minutes')
    ELSE datetime(last_failure_at, '+10 minutes')
  END);

UPDATE jobs
SET next_retry_at = CASE
  WHEN retry_count <= 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+30 minutes')
  WHEN retry_count = 2 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+120 minutes')
  ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+360 minutes')
END
WHERE status = 'failed'
  AND recovery_state = 'retry_wait'
  AND last_failure_at IS NOT NULL
  AND (
    COALESCE(last_error_code, '') = 'RESOURCE_EXHAUSTED'
    OR COALESCE(last_error_code, '') LIKE '%ACCOUNT_LIMITED%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_ALLOCATION%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_QUOTA%'
  )
  AND julianday(next_retry_at) > julianday(CASE
    WHEN retry_count <= 1 THEN datetime(last_failure_at, '+30 minutes')
    WHEN retry_count = 2 THEN datetime(last_failure_at, '+120 minutes')
    ELSE datetime(last_failure_at, '+360 minutes')
  END);

UPDATE daily_plan_slots
SET next_retry_at = CASE
  WHEN retry_count <= 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+1 minute')
  WHEN retry_count = 2 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+3 minutes')
  ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+10 minutes')
END
WHERE status = 'pending'
  AND recovery_state = 'retry_wait'
  AND last_failure_at IS NOT NULL
  AND NOT (
    COALESCE(last_error_code, '') = 'RESOURCE_EXHAUSTED'
    OR COALESCE(last_error_code, '') LIKE '%ACCOUNT_LIMITED%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_ALLOCATION%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_QUOTA%'
  )
  AND julianday(next_retry_at) > julianday(CASE
    WHEN retry_count <= 1 THEN datetime(last_failure_at, '+1 minute')
    WHEN retry_count = 2 THEN datetime(last_failure_at, '+3 minutes')
    ELSE datetime(last_failure_at, '+10 minutes')
  END);

UPDATE daily_plan_slots
SET next_retry_at = CASE
  WHEN retry_count <= 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+30 minutes')
  WHEN retry_count = 2 THEN strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+120 minutes')
  ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_failure_at, '+360 minutes')
END
WHERE status = 'pending'
  AND recovery_state = 'retry_wait'
  AND last_failure_at IS NOT NULL
  AND (
    COALESCE(last_error_code, '') = 'RESOURCE_EXHAUSTED'
    OR COALESCE(last_error_code, '') LIKE '%ACCOUNT_LIMITED%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_ALLOCATION%'
    OR COALESCE(last_error_code, '') LIKE '%DAILY_QUOTA%'
  )
  AND julianday(next_retry_at) > julianday(CASE
    WHEN retry_count <= 1 THEN datetime(last_failure_at, '+30 minutes')
    WHEN retry_count = 2 THEN datetime(last_failure_at, '+120 minutes')
    ELSE datetime(last_failure_at, '+360 minutes')
  END);
