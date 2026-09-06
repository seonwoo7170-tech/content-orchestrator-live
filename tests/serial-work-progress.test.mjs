import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { claimStoredJobExecution } from '../worker/lib/job-store.js';

function fakeDb(row = { mode: 'repair_existing', last_error_code: null, result_json: null }) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) {
          call.values = values;
          return this;
        },
        async first() {
          return row;
        },
        async run() {
          return { meta: { changes: 1 } };
        }
      };
    }
  };
}

test('AI execution claim is a single global lane and full repair starts at Writer', async () => {
  const db = fakeDb();
  const claimed = await claimStoredJobExecution({ ORCHESTRATOR_DB: db }, 95, 'critic_review');
  assert.equal(claimed, true);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[1].values[0], 'writing');
  assert.match(db.calls[1].sql, /NOT EXISTS/);
  assert.match(db.calls[1].sql, /writing.*critic_review.*repairing.*final_critic/s);
});

test('full-rewrite continuation resumes at Critic but protected jobs never claim', async () => {
  const db = fakeDb({
    mode: 'repair_existing',
    last_error_code: 'CRITIC_REVIEW_CONTINUE',
    result_json: JSON.stringify({ rewriteMode: 'full_article_same_post_id', article: { title: 'saved rewrite' } })
  });
  assert.equal(await claimStoredJobExecution({ ORCHESTRATOR_DB: db }, 95, 'writing'), true);
  assert.equal(db.calls[1].values[0], 'critic_review');

  await assert.rejects(
    () => claimStoredJobExecution({ ORCHESTRATOR_DB: fakeDb() }, 36, 'writing'),
    /PROTECTED_JOB_36/
  );
});

test('scheduled wrapper uses a 3-minute watchdog, 30-second serial cooldown and keeps legacy maintenance isolated', async () => {
  const [entry, wrangler] = await Promise.all([
    readFile(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8')
  ]);
  assert.match(entry, /WATCHDOG_CRON = '\*\/3 \* \* \* \*'/);
  assert.match(entry, /LEGACY_MAINTENANCE_CRON = '\*\/5 \* \* \* \*'/);
  assert.match(entry, /SERIAL_AI_COOLDOWN_MS, 30_000/);
  assert.match(entry, /await sleep\(cooldownMs\)/);
  assert.match(entry, /SERIAL_AI_CHAIN_MAX_ITEMS, 4/);
  assert.match(entry, /ACTIVE_AI_JOB/);
  assert.match(entry, /PROVIDER_BACKOFF/);
  assert.match(entry, /DAILY_WORK_EXECUTION_ENABLED:\s*'false'/);
  assert.match(entry, /JOB_RECOVERY_EXECUTION_ENABLED:\s*'false'/);
  assert.match(entry, /SCHEDULED_RECOVERY_FAILED/);
  assert.match(entry, /LEGACY_SCHEDULED_CHAIN_FAILED/);
  assert.match(entry, /SCHEDULED_AUTOMATIC_WORK_FAILED/);
  assert.match(entry, /SERIAL_AI_WATCHDOG/);
  assert.match(wrangler, /"crons":\s*\["\*\/3 \* \* \* \*", "\*\/5 \* \* \* \*"\]/);
  assert.match(wrangler, /"SERIAL_AI_COOLDOWN_MS":\s*"30000"/);
  assert.match(wrangler, /"DAILY_WORK_MAX_ITEMS":\s*"1"/);
  assert.match(wrangler, /"JOB_RECOVERY_MAX_ITEMS":\s*"1"/);
});

test('work UI shows both content and image lanes with live image diagnostics', async () => {
  const [home, live, diagnostics] = await Promise.all([
    readFile(new URL('../web/home-live-status.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/live-work-progress.js', import.meta.url), 'utf8'),
    readFile(new URL('../worker/lib/image-diagnostics.js', import.meta.url), 'utf8')
  ]);
  assert.match(home, /import '\.\/live-work-progress\.js'/);
  for (const label of ['글 작업', '이미지 작업', '전체 재작성', 'Critic', '부분 보완', '최종 Critic', '이미지 생성 중', 'Blogger 업데이트', '글 순차 처리 대기']) {
    assert.ok(live.includes(label), `missing visual label: ${label}`);
  }
  assert.match(live, /\/api\/operations\/images\/diagnostics/);
  assert.match(live, /currentImageWork/);
  assert.match(live, /readyMissingImages/);
  assert.match(live, /KIE 우선/);
  assert.match(live, /같은 글은 즉시 계속 · 다음 글은 10초 후/);
  assert.doesNotMatch(live, /완료 후 10초 뒤 다음 이미지/);
  assert.match(live, /document\.addEventListener\('click', interceptManualRun, true\)/);
  assert.match(live, /manualQueue/);
  assert.match(live, /POLL_MS = 5000/);
  assert.match(diagnostics, /imageState/);
  assert.match(diagnostics, /activeImageJobs/);
  assert.match(diagnostics, /generating/);
  assert.match(diagnostics, /attaching/);
});