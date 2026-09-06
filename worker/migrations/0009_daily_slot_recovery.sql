ALTER TABLE daily_plan_slots ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_plan_slots ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'none' CHECK (recovery_state IN ('none', 'retry_wait', 'held'));
ALTER TABLE daily_plan_slots ADD COLUMN next_retry_at TEXT;
ALTER TABLE daily_plan_slots ADD COLUMN hold_reason TEXT;
ALTER TABLE daily_plan_slots ADD COLUMN last_error_code TEXT;
ALTER TABLE daily_plan_slots ADD COLUMN last_failure_at TEXT;

CREATE INDEX IF NOT EXISTS idx_daily_slot_recovery_due
ON daily_plan_slots(plan_date, status, recovery_state, next_retry_at, id);
