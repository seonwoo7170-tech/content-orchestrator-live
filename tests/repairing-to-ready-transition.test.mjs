import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertTransition } from '../worker/lib/state-machine.js';

// Letting the deterministic gate decide publication changed which states the quality loop can
// return READY from. Two of its exits sit inside the repair block -- the guard rejecting the last
// attempt, and a repair that could not be applied -- and both used to mean FAIL, which reached
// needs_review. They now resolve through resolveAfterAdvisoryReview, so the executor asks for
// repairing -> ready. The state machine rejected it, and jobs 157, 234, 236, 241, 246, 251 and 252
// all died on JOB_TRANSITION_INVALID with a finished article in hand.
test('a job can reach ready from repairing', () => {
  assert.equal(assertTransition('repairing', 'ready'), true);
});

test('the states the loop can still return from also reach ready', () => {
  assert.equal(assertTransition('critic_review', 'ready'), true);
  assert.equal(assertTransition('final_critic', 'ready'), true);
});

// needs_review must keep working from repairing: the deterministic gate can still block.
test('repairing can still reach needs_review and failed', () => {
  assert.equal(assertTransition('repairing', 'needs_review'), true);
  assert.equal(assertTransition('repairing', 'failed'), true);
});

// This is a targeted widening, not a general one: writing must not jump the review entirely.
test('writing still cannot skip straight to ready', () => {
  assert.throws(() => assertTransition('writing', 'ready'), /JOB_TRANSITION_INVALID/);
});

test('a completed or failed job is still terminal', () => {
  assert.throws(() => assertTransition('completed', 'ready'), /JOB_TRANSITION_INVALID/);
  assert.throws(() => assertTransition('failed', 'queued'), /JOB_TRANSITION_INVALID/);
});

// The two exits that make this reachable, pinned so the reason cannot be lost.
test('the quality loop really does return from inside the repair block', async () => {
  const pipeline = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  const repairBlock = pipeline.slice(pipeline.indexOf("emitStage(hooks, issueSource === 'linter' ? 'style_repairing' : 'repairing'"));
  assert.match(repairBlock, /reviewReason: 'TARGETED_REPAIR_SCOPE_VIOLATION'/);
  assert.ok(
    repairBlock.indexOf('resolveAfterAdvisoryReview') < repairBlock.indexOf('function readyResult'),
    'the repair block must still contain a loop exit'
  );
});
