import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const progress = fs.readFileSync('web/work-live-progress.js', 'utf8');

test('reasonText prefers the detailed jobs.error over the bare hold_reason/last_error_code when it says more', () => {
  const start = progress.indexOf('function reasonText');
  const end = progress.indexOf('function installStyles');
  assert.ok(start >= 0 && end > start);
  const source = progress.slice(start, end);
  // Must compare against the bare code, not just take row.error unconditionally --
  // otherwise a stale/unrelated jobs.error from an earlier failure could outrank a
  // fresher, correctly-classified hold_reason/last_error_code.
  assert.match(source, /detailed\.length > bare\.length/);
  assert.match(source, /detailed\.toUpperCase\(\)\.startsWith\(bare\.toUpperCase\(\)\)/);
});
