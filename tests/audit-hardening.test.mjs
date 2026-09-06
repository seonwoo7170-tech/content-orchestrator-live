import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { claimStoredJobExecution } from '../worker/lib/job-store.js';

const publisher = fs.readFileSync(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../web/home-live-status.js', import.meta.url), 'utf8');

test('stored job execution claim is conditional on queued state and an idle global AI lane', async () => {
  const calls = [];
  const env = {
    ORCHESTRATOR_DB: {
      prepare(statement) {
        const call = { statement, binds: [] };
        calls.push(call);
        return {
          bind(...values) {
            call.binds = values;
            return this;
          },
          async first() {
            return { mode: 'new_article', last_error_code: null, result_json: null };
          },
          async run() {
            return { meta: { changes: 1 } };
          }
        };
      }
    }
  };
  assert.equal(await claimStoredJobExecution(env, 7, 'writing'), true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].statement, /status = 'queued'/);
  assert.match(calls[1].statement, /NOT EXISTS/);
  assert.match(calls[1].statement, /writing.*critic_review.*repairing.*final_critic/s);
  assert.deepEqual(calls[1].binds, ['writing', 7, 7]);
});

test('new-post stale claim recovery cannot consume repair claims', () => {
  assert.match(publisher, /job_id IN \(SELECT id FROM jobs WHERE mode = 'new_article'\)/);
});

test('scheduled AdSense collection is enabled while Pinterest delivery remains gated', () => {
  assert.match(wrangler, /"ADSENSE_COLLECTION_ENABLED": "true"/);
  assert.match(wrangler, /"EXTERNAL_DISTRIBUTION_ENABLED": "false"/);
});

test('home live status includes publication attention in addition to job recovery', () => {
  assert.match(home, /\/api\/operations\/publications\/today/);
  assert.match(home, /publicationAttention/);
  assert.match(home, /발행확인/);
});