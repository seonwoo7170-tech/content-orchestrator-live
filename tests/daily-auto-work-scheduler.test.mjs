import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledAutomaticWork, runScheduledCoreTick, runScheduledJobRecovery } from '../worker/entry.js';

test('scheduled automatic work fails closed when execution gate is disabled', async () => {
  const result = await runScheduledAutomaticWork({}, new Date('2026-08-30T18:00:00Z'));
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'DAILY_WORK_EXECUTION_DISABLED');
  assert.equal(result.attempted, 0);
});

test('scheduled automatic work passes Seoul operation date and configured max items to runner', async () => {
  const blogs = [{ blogId: 'b1', name: 'Blog 1' }];
  const automation = { global: { enabled: true }, blogs: [] };
  let captured = null;
  const runner = async (env, passedBlogs, passedAutomation, options) => {
    captured = { env, passedBlogs, passedAutomation, options };
    return { ok: true, enabled: true, attempted: 0, completed: 0, items: [] };
  };
  const env = {
    DAILY_WORK_EXECUTION_ENABLED: 'true',
    DAILY_WORK_MAX_ITEMS: '2',
    OPERATIONS_TIMEZONE: 'Asia/Seoul'
  };
  const now = new Date('2026-08-30T18:00:00Z');
  const result = await runScheduledAutomaticWork(env, now, { blogs, automation, runner });
  assert.equal(result.ok, true);
  assert.deepEqual(captured.passedBlogs, blogs);
  assert.deepEqual(captured.passedAutomation, automation);
  assert.equal(captured.options.planDate, '2026-08-31');
  assert.equal(captured.options.maxItems, '2');
  assert.equal(captured.options.now, now);
});

test('manual work tick can override the scheduled max item limit without changing env', async () => {
  const blogs = [{ blogId: 'b1', name: 'Blog 1' }];
  const automation = { global: { enabled: true }, blogs: [] };
  let captured = null;
  const runner = async (_env, _blogs, _automation, options) => {
    captured = options;
    return { ok: true, enabled: true, attempted: 0, completed: 0, items: [] };
  };
  const env = { DAILY_WORK_EXECUTION_ENABLED: 'true', DAILY_WORK_MAX_ITEMS: '1', OPERATIONS_TIMEZONE: 'Asia/Seoul' };
  await runScheduledAutomaticWork(env, new Date('2026-09-02T09:00:00Z'), { blogs, automation, runner, maxItems: 4 });
  assert.equal(captured.maxItems, 4);
  assert.equal(env.DAILY_WORK_MAX_ITEMS, '1');
});

test('scheduled core tick isolates one task failure and continues independent automation tasks', async () => {
  const calls = [];
  const tasks = {
    dailyPlan: async () => { calls.push('dailyPlan'); throw new Error('API_HUB_TIMEOUT'); },
    automaticWork: async () => { calls.push('automaticWork'); return { ok: true, attempted: 1, completed: 1 }; },
    jobRecovery: async () => { calls.push('jobRecovery'); return { ok: true, attempted: 0, completed: 0 }; },
    autoPublish: async () => { calls.push('autoPublish'); return { ok: true, attempted: 1, published: 1 }; },
    gsc: async () => { calls.push('gsc'); return { ok: true, enabled: true, due: false }; },
    ga4: async () => { calls.push('ga4'); return { ok: true, enabled: true, due: false }; }
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await runScheduledCoreTick({}, new Date('2026-09-02T09:00:00Z'), { tasks });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [{ name: 'dailyPlan', errorCode: 'API_HUB_TIMEOUT' }]);
    assert.ok(calls.includes('automaticWork'));
    assert.ok(calls.includes('jobRecovery'));
    assert.ok(calls.includes('autoPublish'));
    assert.ok(calls.includes('gsc'));
    assert.ok(calls.includes('ga4'));
  } finally {
    console.log = originalLog;
  }
});

test('scheduled recovery fails closed without its independent execution gate', async () => {
  const result = await runScheduledJobRecovery({}, new Date('2026-08-30T18:00:00Z'));
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'JOB_RECOVERY_EXECUTION_DISABLED');
  assert.equal(result.attempted, 0);
});

test('scheduled recovery passes configured limit, time and automation settings to runner', async () => {
  const blogs = [{ blogId:'b1', name:'Blog 1' }];
  const automation = { global:{enabled:true}, blogs:[{blogId:'b1',effective:{imagesEnabled:true}}] };
  let captured = null;
  const runner = async (env, options) => {
    captured = { env, options };
    return { ok:true, enabled:true, attempted:0, completed:0, items:[] };
  };
  const env = { JOB_RECOVERY_EXECUTION_ENABLED:'true', JOB_RECOVERY_MAX_ITEMS:'2' };
  const now = new Date('2026-08-30T18:05:00Z');
  const result = await runScheduledJobRecovery(env, now, { blogs, automation, runner });
  assert.equal(result.ok, true);
  assert.equal(captured.options.maxItems, '2');
  assert.equal(captured.options.now, now);
  assert.deepEqual(captured.options.automation, automation);
});
