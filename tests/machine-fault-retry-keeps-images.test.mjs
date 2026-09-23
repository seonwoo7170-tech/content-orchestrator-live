import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');

// JOB_TRANSITION_INVALID is the machinery refusing a transition, not a verdict about the article,
// and the article is finished when it happens. Leaving it off the preserved list sent every such
// retry down the branch that nulls result_json and deletes job_images -- paid KIE generations --
// which is what happened to jobs 157, 234, 236, 241, 246 and 251 on 2026-09-23.
test('a transition failure keeps its article on a manual retry', () => {
  const codes = source.slice(source.indexOf('const CONTINUATION_RESULT_CODES'), source.indexOf('const CONTINUATION_BUDGET_EXHAUSTED_CODES'));
  assert.match(codes, /'JOB_TRANSITION_INVALID'/);
  assert.match(codes, /'CRITIC_SCHEMA_INVALID'/);
});

// The stronger guarantee: the article can be gone -- the transition threw before it was saved --
// and the images must still survive, because regenerating them costs money for nothing.
test('a machine-fault retry keeps its paid images even with no saved article', () => {
  assert.match(source, /const preserveImages = preserveContinuation \|\| preservePublishReady \|\| isMachineFaultRetry\(row\);/);
  const set = source.slice(source.indexOf('const MACHINE_FAULT_RETRY_CODES'), source.indexOf('function isMachineFaultRetry'));
  assert.match(set, /\.\.\.CONTINUATION_RESULT_CODES/);
  assert.match(set, /'STALE_PIPELINE_EXECUTION'/);
});

// A content verdict is not a machine fault: those retries still start clean.
test('an ordinary failure still clears its images', () => {
  const set = source.slice(source.indexOf('const MACHINE_FAULT_RETRY_CODES'), source.indexOf('function isMachineFaultRetry'));
  assert.doesNotMatch(set, /API_HUB_TIMEOUT|WRITER_|IMAGE_QA/);
  assert.match(source, /if \(!preserveImages\) \{\s*statements\.push\(db\.prepare\('DELETE FROM job_images WHERE job_id = \?'\)/);
});

// Preserving the article still requires there to be one, so a code alone cannot resurrect nothing.
test('preserving the article still requires an article', () => {
  const fn = source.slice(source.indexOf('function hasContinuationResult'), source.indexOf('function isQualityLimitHold'));
  assert.match(fn, /return Boolean\(result\?\.article && typeof result\.article === 'object'\);/);
});
