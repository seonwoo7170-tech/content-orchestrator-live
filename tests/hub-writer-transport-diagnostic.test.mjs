import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper = readFileSync(new URL('../worker/lib/hub-writer-transport-diagnostic.js', import.meta.url), 'utf8');
const phase6Entry = readFileSync(new URL('../worker/phase6-trends-entry.js', import.meta.url), 'utf8');
const mcpEntry = readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
const maintenanceEntry = readFileSync(new URL('../worker/maintenance-entry.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');

test('runtime Writer transport diagnostic is admin-only and never calls Blogger writes', () => {
  assert.match(helper, /requireAdmin\(request, env\)/);
  assert.match(helper, /\/api\/diagnostics\/hub-writer-transport/);
  assert.match(helper, /\/api\/hub\/ai\/writer/);
  assert.doesNotMatch(helper, /\/api\/blogger\/post['"`]/);
});

test('runtime diagnostic uses Service Binding as authoritative transport and skips direct public fallback', () => {
  assert.match(helper, /API_HUB_SERVICE\.fetch/);
  assert.match(helper, /directBindingProbe/);
  assert.match(helper, /managedProbe/);
  assert.match(helper, /callHub\(env, WRITER_PATH, WRITER_PAYLOAD\)/);
  assert.match(helper, /service-binding-authoritative/);
  assert.match(helper, /SERVICE_BINDING_AUTHORITATIVE/);
  assert.doesNotMatch(helper, /directPublicProbe/);
});

test('Phase 6 entry exposes the diagnostic without replacing normal routing', () => {
  assert.match(phase6Entry, /HUB_WRITER_TRANSPORT_DIAGNOSTIC_PATH/);
  assert.match(phase6Entry, /handleHubWriterTransportDiagnostic\(request, env\)/);
  assert.match(phase6Entry, /return phase6Entry\.fetch\(request, env, ctx\)/);
  assert.match(phase6Entry, /return phase6Entry\.scheduled\(event, env, ctx\)/);
});

test('production maintenance wrapper preserves MCP and Phase 6 while globally paused', () => {
  assert.match(wrangler, /"main":\s*"worker\/maintenance-entry\.js"/);
  assert.match(wrangler, /"SYSTEM_PAUSED":\s*"true"/);
  assert.match(maintenanceEntry, /import app from '\.\/mcp-entry\.js'/);
  assert.match(mcpEntry, /import app from '\.\/phase6-trends-entry\.js'/);
  assert.match(mcpEntry, /return app\.fetch\(request, env, ctx\)/);
  assert.match(mcpEntry, /DAILY_WORK_EXECUTION_ENABLED:\s*'false'/);
  assert.match(mcpEntry, /JOB_RECOVERY_EXECUTION_ENABLED:\s*'false'/);
  assert.match(mcpEntry, /await app\.scheduled\(event, delegatedEnv, ctx\)/);
  assert.match(mcpEntry, /await runScheduledAutomaticWork/);
  assert.match(mcpEntry, /await runScheduledJobRecovery/);
});
