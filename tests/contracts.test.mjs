import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase1Snapshot, normalizeExistingRepairRequest, validateCriticResult } from '../worker/lib/contracts.js';

test('Phase 1 progress is derived from evidence keys', () => {
  const state = createPhase1Snapshot(['blogger_connection', 'blog_list']);
  assert.equal(state.completed, 2);
  assert.equal(state.total, 6);
  assert.equal(state.items[2].verified, false);
});

test('existing repair requires original Blogger Post ID', () => {
  assert.throws(() => normalizeExistingRepairRequest({ blogId: '123' }), /BLOGGER_POST_ID_REQUIRED/);
  const job = normalizeExistingRepairRequest({ blogId: '123', bloggerPostId: '456', targetUrl: 'https://example.com/p' });
  assert.equal(job.mode, 'repair_existing');
  assert.equal(job.bloggerPostId, '456');
});

test('critic PASS cannot contain issues', () => {
  assert.throws(() => validateCriticResult({ status: 'PASS', issues: [{ code:'X', severity:'LOW', location:'x', reason:'x', repairInstruction:'x' }] }), /PASS_WITH_ISSUES/);
});

test('critic FAIL requires structured issues', () => {
  const result = validateCriticResult({ status: 'FAIL', issues: [{ code:'SOURCE_WEAK', severity:'HIGH', location:'section-2', reason:'weak source', repairInstruction:'replace only this section' }] });
  assert.equal(result.issues[0].code, 'SOURCE_WEAK');
});
