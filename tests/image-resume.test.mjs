import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCompletionState } from '../worker/lib/image-completion.js';
import { isResumableImageStatus } from '../worker/lib/image-executor.js';

test('image completion requires every expected image to be durably stored or attached', () => {
  assert.deepEqual(
    imageCompletionState([
      { status: 'attached' },
      { status: 'stored' },
      { status: 'stored' }
    ], 3),
    { complete: true, attached: 1, stored: 3, unresolved: 0, count: 3, expected: 3 }
  );

  const interrupted = imageCompletionState([
    { status: 'generated' },
    { status: 'planned' },
    { status: 'planned' }
  ], 3);
  assert.equal(interrupted.complete, false);
  assert.equal(interrupted.unresolved, 3);
});

test('planned, generated, and retryable failed images can resume while stored images are skipped', () => {
  assert.equal(isResumableImageStatus('planned'), true);
  assert.equal(isResumableImageStatus('generated'), true);
  assert.equal(isResumableImageStatus('failed', true), true);
  assert.equal(isResumableImageStatus('failed', false), false);
  assert.equal(isResumableImageStatus('stored'), false);
  assert.equal(isResumableImageStatus('attached'), false);
});
