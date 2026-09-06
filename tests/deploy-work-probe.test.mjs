import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('deployment fails on Worker HTTP 5xx but treats transport reset as inconclusive', () => {
  assert.match(workflow, /PRODUCTION_WORK_TICK_FAILED/);
  assert.match(workflow, /hardFailure:true/);
  assert.match(workflow, /PRODUCTION_WORK_TICK_INCONCLUSIVE/);
  assert.match(workflow, /PRODUCTION_PROGRESS_READBACK_FAILED/);
  assert.match(workflow, /PRODUCTION_AUTOMATION_GATE_READBACK_FAILED/);
});

test('inconclusive probe is followed by health, today and recovery readback', () => {
  assert.match(workflow, /\/api\/operations\/today/);
  assert.match(workflow, /\/api\/operations\/recovery/);
  assert.match(workflow, /\/health\?probe=/);
});
