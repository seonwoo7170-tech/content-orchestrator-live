ALTER TABLE job_images ADD COLUMN provider_attempt_count INTEGER NOT NULL DEFAULT 0;

UPDATE job_images
   SET provider_attempt_count = 1
 WHERE provider_task_id IS NOT NULL
   AND provider_task_id <> ''
   AND provider_attempt_count = 0;
