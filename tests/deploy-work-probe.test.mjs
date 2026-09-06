import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('public production deploy preserves runtime secrets and requires only Cloudflare deployment credentials', () => {
  assert.match(workflow, /CLOUDFLARE_DEPLOY_API_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /secrets\.HUB_API_KEY/);
  assert.doesNotMatch(workflow, /secrets\.ADMIN_API_KEY/);
  assert.doesNotMatch(workflow, /--secrets-file/);
  assert.match(workflow, /wrangler@latest deploy --config wrangler\.jsonc/);
});

test('public deployment readback verifies production automation gates without exposing admin credentials', () => {
  assert.match(workflow, /Production public health read-back/);
  assert.match(workflow, /\/health\?deploy=/);
  assert.match(workflow, /bloggerWritesEnabled===true/);
  assert.match(workflow, /phase2Automation\?\.autoPublishExecutionEnabled===true/);
  assert.match(workflow, /PRODUCTION_PUBLIC_HEALTH_READBACK_FAILED/);
  assert.doesNotMatch(workflow, /x-admin-api-key/);
  assert.doesNotMatch(workflow, /\/api\/operations\/work-tick/);
});
