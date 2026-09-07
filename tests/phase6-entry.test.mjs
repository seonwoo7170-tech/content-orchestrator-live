import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const entry = fs.readFileSync(new URL('../worker/phase6-entry.js', import.meta.url), 'utf8');
const wrapper = fs.readFileSync(new URL('../worker/phase6-trends-entry.js', import.meta.url), 'utf8');
const mcpEntry = fs.readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
const maintenanceEntry = fs.readFileSync(new URL('../worker/maintenance-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../web/external-traffic.js', import.meta.url), 'utf8');

test('production maintenance wrapper preserves MCP, trend and Phase 6 routing while paused', () => {
  assert.match(wrangler, /"main": "worker\/maintenance-entry\.js"/);
  assert.match(wrangler, /"SYSTEM_PAUSED": "true"/);
  assert.match(maintenanceEntry, /import app from '\.\/mcp-entry\.js'/);
  assert.match(wrangler, /"\/go\/\*"/);
  assert.match(wrangler, /"\/mcp"/);
  assert.match(mcpEntry, /import app from '\.\/phase6-trends-entry\.js'/);
  assert.match(mcpEntry, /return app\.fetch\(request, env, ctx\)/);
  assert.match(mcpEntry, /await app\.scheduled\(event, delegatedEnv, ctx\)/);
  assert.match(mcpEntry, /await runScheduledAutomaticWork/);
  assert.match(mcpEntry, /await runScheduledJobRecovery/);
  assert.ok(mcpEntry.indexOf('await runScheduledJobRecovery') < mcpEntry.indexOf('await app.scheduled'));
  assert.ok(mcpEntry.indexOf('await runScheduledJobRecovery') < mcpEntry.indexOf('await runScheduledAutomaticWork'));
  assert.match(mcpEntry, /RECOVERY_PRIORITY/);
  assert.match(mcpEntry, /LEGACY_SCHEDULED_CHAIN_FAILED/);
  assert.match(wrapper, /import phase6Entry from '\.\/phase6-entry\.js'/);
  assert.match(wrapper, /return phase6Entry\.fetch\(request, env, ctx\)/);
  assert.match(wrapper, /return phase6Entry\.scheduled\(event, env, ctx\)/);
  assert.match(entry, /trackingRedirect/);
  assert.match(entry, /resolveExternalTrackingRedirect/);
});

test('external delivery is disabled by default and Pinterest token is never stored in public config or UI', () => {
  assert.match(wrangler, /"EXTERNAL_DISTRIBUTION_ENABLED": "false"/);
  assert.doesNotMatch(wrangler, /PINTEREST_ACCESS_TOKEN/);
  assert.doesNotMatch(ui, /access[_ -]?token|PINTEREST_ACCESS_TOKEN/i);
});

test('external scheduled maintenance isolates its failure before delegating to Phase 5 core automation', () => {
  assert.match(entry, /runExternalMaintenance\(env, now\)\.catch/);
  assert.match(entry, /return phase5Entry\.scheduled\(event, env, ctx\)/);
  assert.match(entry, /EXTERNAL_TRAFFIC_TICK_FAILED/);
});
