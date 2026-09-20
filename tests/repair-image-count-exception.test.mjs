import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');

test('a fixed allowlist of job ids is exempted from the image-completeness check', () => {
  assert.match(source, /REPAIR_IMAGE_COUNT_EXCEPTION_JOB_IDS\s*=\s*new Set\(\[140, 141, 143, 158, 159, 160\]\)/);
  assert.match(source, /REPAIR_IMAGE_COUNT_EXCEPTION_MIN_IMAGES\s*=\s*3/);
});

test('the exception only applies to allowlisted jobs that already meet the minimum image count', () => {
  assert.match(source, /REPAIR_IMAGE_COUNT_EXCEPTION_JOB_IDS\.has\(Number\(jobId\)\)/);
  assert.match(source, /Number\(imagePolicy\.currentCount \|\| 0\)\s*>=\s*REPAIR_IMAGE_COUNT_EXCEPTION_MIN_IMAGES/);
});

test('both scheduling and execution paths pass the job id through to the eligibility check', () => {
  assert.match(source, /validateRepairResult\(result, settings, candidate\.job_id\)/);
  assert.match(source, /validateRepairResult\(result, settings, action\.job_id\)/);
});

test('an exempted job is not reported as blocked on REPAIR_IMAGES_INCOMPLETE', () => {
  assert.match(source, /imageCountException:\s*true/);
  assert.match(source, /exception:\s*'REPAIR_IMAGE_COUNT_EXCEPTION'/);
});

test('the exception is scoped and does not relax the general target check', () => {
  assert.match(source, /targetImages: imagePolicy\.policy\?\.targetTotal \|\| 0/);
  assert.doesNotMatch(source, /REPAIR_IMAGE_COUNT_EXCEPTION_MIN_IMAGES\s*=\s*[0-2]\b/);
});
