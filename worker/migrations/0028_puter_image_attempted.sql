ALTER TABLE job_images ADD COLUMN puter_attempted INTEGER NOT NULL DEFAULT 0;

UPDATE job_images
   SET puter_attempted = 1
 WHERE LOWER(COALESCE(provider, '')) = 'puter';
