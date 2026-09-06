import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const phase6 = fs.readFileSync(new URL('../worker/phase6-entry.js', import.meta.url), 'utf8');

test('disabled external distribution skips the five-minute asset sync before D1 inventory reads', () => {
  assert.match(phase6, /function externalDistributionEnabled\(env\)/);
  assert.match(phase6, /EXTERNAL_DISTRIBUTION_DISABLED/);
  const start = phase6.indexOf('async function runExternalMaintenance');
  const end = phase6.indexOf('export default', start);
  const maintenance = phase6.slice(start, end);
  assert.ok(maintenance.indexOf('if (!externalDistributionEnabled(env))') >= 0);
  assert.ok(maintenance.indexOf('if (!externalDistributionEnabled(env))') < maintenance.indexOf('loadConnectedBlogs(env)'));
  assert.ok(maintenance.indexOf('if (!externalDistributionEnabled(env))') < maintenance.indexOf('syncExternalContentAssets(env'));
});
