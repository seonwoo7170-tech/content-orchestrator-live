ALTER TABLE job_images ADD COLUMN provider_task_id TEXT;
ALTER TABLE job_images ADD COLUMN provider_status TEXT;
ALTER TABLE job_images ADD COLUMN provider_error_code TEXT;
ALTER TABLE job_images ADD COLUMN provider_error_message TEXT;
ALTER TABLE job_images ADD COLUMN provider_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_job_images_provider_task
  ON job_images(provider, provider_task_id, status);
