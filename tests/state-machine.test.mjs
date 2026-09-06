import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, nextAfterCritic } from '../worker/lib/state-machine.js';

test('final critic PASS can move to ready', () => {
  assert.equal(nextAfterCritic({ mode: 'repair_existing', criticStatus: 'PASS' }), 'ready');
});

test('failed critic repairs until retry cap then requires review', () => {
  assert.equal(nextAfterCritic({ mode: 'new_article', criticStatus: 'FAIL', repairAttempts: 0, maxRepairAttempts: 3 }), 'repairing');
  assert.equal(nextAfterCritic({ mode: 'new_article', criticStatus: 'FAIL', repairAttempts: 2, maxRepairAttempts: 3 }), 'repairing');
  assert.equal(nextAfterCritic({ mode: 'new_article', criticStatus: 'FAIL', repairAttempts: 3, maxRepairAttempts: 3 }), 'needs_review');
});

test('bounded repair loops and fresh-candidate fallback are valid transitions', () => {
  assert.equal(assertTransition('writing', 'repairing'), true);
  assert.equal(assertTransition('repairing', 'critic_review'), true);
  assert.equal(assertTransition('critic_review', 'repairing'), true);
  assert.equal(assertTransition('final_critic', 'repairing'), true);
  assert.equal(assertTransition('repairing', 'writing'), true);
  assert.equal(assertTransition('final_critic', 'writing'), true);
});

test('invalid state transition is blocked', () => {
  assert.throws(() => assertTransition('queued', 'completed'), /JOB_TRANSITION_INVALID/);
  assert.equal(assertTransition('ready', 'updating_existing'), true);
});
