import test from 'node:test';
import assert from 'node:assert/strict';
import { readyImageState } from '../worker/lib/image-diagnostics.js';

test('async KIE waiting and generating provider states count as active image work', () => {
  assert.equal(readyImageState(false, { planned: 1 }, { waiting: 1 }), 'generating');
  assert.equal(readyImageState(false, { planned: 1 }, { generating: 1 }), 'generating');
});

test('failed and attach states retain higher-fidelity display status', () => {
  assert.equal(readyImageState(false, { failed: 1 }, { generating: 1 }), 'failed');
  assert.equal(readyImageState(false, { stored: 1 }, { none: 1 }), 'attaching');
  assert.equal(readyImageState(true, { attached: 3 }, { success: 3 }), 'complete');
});
