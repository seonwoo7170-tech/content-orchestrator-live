import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJobListLimit } from '../worker/lib/job-store.js';

test('job list uses a safe default and caps large requests', () => {
  assert.equal(normalizeJobListLimit(undefined), 30);
  assert.equal(normalizeJobListLimit('50'), 50);
  assert.equal(normalizeJobListLimit('999'), 100);
});

test('job list rejects invalid limits', () => {
  assert.throws(() => normalizeJobListLimit('0'), /JOB_LIST_LIMIT_INVALID/);
  assert.throws(() => normalizeJobListLimit('abc'), /JOB_LIST_LIMIT_INVALID/);
});
