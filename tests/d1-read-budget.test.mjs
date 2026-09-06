import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workload = fs.readFileSync(new URL('../worker/lib/adaptive-workload.js', import.meta.url), 'utf8');
const diagnostics = fs.readFileSync(new URL('../worker/lib/daily-diagnostics.js', import.meta.url), 'utf8');

test('daily planning reads only the active job queue and aggregates once per blog', () => {
  assert.match(workload, /WHERE archived_at IS NULL/);
  assert.match(workload, /SUM\(CASE WHEN status IN/);
  assert.match(workload, /GROUP BY blog_id`/);
  assert.doesNotMatch(workload, /GROUP BY blog_id, status, recovery_state, updated_at/);
});

test('daily diagnostics exclude archived historical jobs from repeated self-heal reads', () => {
  assert.match(diagnostics, /FROM jobs\s+WHERE archived_at IS NULL\s+AND status <> 'completed'/);
});
