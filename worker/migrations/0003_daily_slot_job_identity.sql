ALTER TABLE jobs ADD COLUMN daily_slot_id INTEGER REFERENCES daily_plan_slots(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_daily_slot
ON jobs(daily_slot_id)
WHERE daily_slot_id IS NOT NULL;
