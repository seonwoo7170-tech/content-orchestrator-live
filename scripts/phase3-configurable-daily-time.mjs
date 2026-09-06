import fs from 'node:fs';

function replaceOnce(path, before, after, label) {
  const source = fs.readFileSync(path, 'utf8');
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`${label}:MATCH_NOT_FOUND:${path}`);
  if (first !== last) throw new Error(`${label}:MATCH_NOT_UNIQUE:${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}

function create(path, content) {
  if (fs.existsSync(path)) throw new Error(`CREATE_TARGET_EXISTS:${path}`);
  fs.writeFileSync(path, content);
}

replaceOnce(
  'worker/lib/automation-settings.js',
  "  enabled: true,\n  newArticlesEnabled: true,",
  "  enabled: true,\n  dailyOperationStartTime: '03:00',\n  newArticlesEnabled: true,",
  'ADD_DAILY_OPERATION_DEFAULT'
);
replaceOnce(
  'worker/lib/automation-settings.js',
  "function time(value, fallback) {\n  const text = String(value ?? fallback).trim();\n  if (!/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(text)) throw new Error('PUBLISH_START_TIME_INVALID');\n  return text;\n}",
  "function time(value, fallback, code = 'PUBLISH_START_TIME_INVALID') {\n  const text = String(value ?? fallback).trim();\n  if (!/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(text)) throw new Error(code);\n  return text;\n}",
  'GENERALIZE_TIME_VALIDATOR'
);
replaceOnce(
  'worker/lib/automation-settings.js',
  "    enabled: bool(input.enabled, base.enabled),\n    newArticlesEnabled: bool(input.newArticlesEnabled, base.newArticlesEnabled),",
  "    enabled: bool(input.enabled, base.enabled),\n    dailyOperationStartTime: time(input.dailyOperationStartTime, base.dailyOperationStartTime, 'DAILY_OPERATION_START_TIME_INVALID'),\n    newArticlesEnabled: bool(input.newArticlesEnabled, base.newArticlesEnabled),",
  'NORMALIZE_DAILY_OPERATION_TIME'
);
replaceOnce(
  'worker/lib/automation-settings.js',
  "  return { planDate, blogs, totalWork: blogs.reduce((sum, blog) => sum + blog.work.newArticles + blog.work.repairs, 0), totalAutoPublishes: blogs.reduce((sum, blog) => sum + blog.publishing.times.length, 0) };",
  "  const global = automation?.global || DEFAULT_AUTOMATION_SETTINGS;\n  return {\n    planDate,\n    dailyOperationStartTime: global.dailyOperationStartTime,\n    timezone: global.timezone,\n    blogs,\n    totalWork: blogs.reduce((sum, blog) => sum + blog.work.newArticles + blog.work.repairs, 0),\n    totalAutoPublishes: blogs.reduce((sum, blog) => sum + blog.publishing.times.length, 0)\n  };",
  'EXPOSE_DAILY_OPERATION_PREVIEW'
);

create('worker/lib/daily-operation-schedule.js', `function minutesOfDay(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

export function localClock(now = new Date(), timezone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('DAILY_OPERATION_LOCAL_TIME_INVALID');
  return { hour, minute, minutes: hour * 60 + minute };
}

export function isDailyOperationDue(settings = {}, now = new Date(), pollMinutes = 5) {
  const start = minutesOfDay(settings.dailyOperationStartTime || '03:00');
  if (start === null) throw new Error('DAILY_OPERATION_START_TIME_INVALID');
  const current = localClock(now, settings.timezone || 'Asia/Seoul').minutes;
  const delta = current - start;
  return delta >= 0 && delta < pollMinutes;
}
`);

replaceOnce(
  'worker/entry.js',
  "import { normalizeBlogList } from './lib/blog-registry.js';\nimport { ensureDailyPlan } from './lib/daily-operations.js';",
  "import { normalizeBlogList } from './lib/blog-registry.js';\nimport { readAutomationSettings } from './lib/automation-settings.js';\nimport { isDailyOperationDue } from './lib/daily-operation-schedule.js';\nimport { ensureDailyPlan } from './lib/daily-operations.js';",
  'ADD_SCHEDULE_IMPORTS'
);
replaceOnce(
  'worker/entry.js',
  "export async function runScheduledDailyPlan(env, now = new Date()) {\n  return ensureDailyPlan(env, await connectedBlogs(env), { now });\n}\n\nexport async function runScheduledAutoPublish",
  "export async function runScheduledDailyPlan(env, now = new Date()) {\n  return ensureDailyPlan(env, await connectedBlogs(env), { now });\n}\n\nexport async function runScheduledDailyPlanIfDue(env, now = new Date()) {\n  const automation = await readAutomationSettings(env, []);\n  const settings = automation?.global || {};\n  if (!isDailyOperationDue(settings, now, 5)) {\n    return { ok: true, due: false, startTime: settings.dailyOperationStartTime || '03:00', timezone: settings.timezone || 'Asia/Seoul' };\n  }\n  const result = await runScheduledDailyPlan(env, now);\n  return { ...result, due: true, startTime: settings.dailyOperationStartTime || '03:00', timezone: settings.timezone || 'Asia/Seoul' };\n}\n\nexport async function runScheduledAutoPublish",
  'ADD_DUE_DAILY_PLAN_RUNNER'
);
replaceOnce(
  'worker/entry.js',
  "    if (event?.cron === '0 21 * * *') {\n      ctx.waitUntil(runScheduledDailyPlan(env, now));\n      return;\n    }\n    if (event?.cron === '*/5 * * * *') {\n      ctx.waitUntil(runScheduledAutoPublish(env, now));\n    }",
  "    if (event?.cron === '*/5 * * * *') {\n      ctx.waitUntil(Promise.all([\n        runScheduledDailyPlanIfDue(env, now),\n        runScheduledAutoPublish(env, now)\n      ]));\n    }",
  'REPLACE_FIXED_DAILY_CRON_DISPATCH'
);

replaceOnce(
  'wrangler.example.jsonc',
  '    "crons": ["0 21 * * *", "*/5 * * * *"]',
  '    "crons": ["*/5 * * * *"]',
  'REMOVE_FIXED_0600_CRON'
);

replaceOnce(
  'web/automation.js',
  "function settingsFields() {",
  "function globalScheduleFields() {\n  return `\n    <div class=\"automation-grid automation-global-schedule\">\n      ${field('dailyOperationStartTime', '일일 자동운영 시작', 'time', 'step=\"300\"')}\n    </div>\n    <div class=\"automation-warning\">매일 이 시각에 블로그 상태 진단과 그날의 작업 계획을 시작합니다. 5분 단위로 조정할 수 있습니다.</div>`;\n}\n\nfunction settingsFields() {",
  'ADD_GLOBAL_SCHEDULE_FIELD'
);
replaceOnce(
  'web/automation.js',
  "    enabled: checked('enabled'),\n    newArticlesEnabled: checked('newArticlesEnabled'),",
  "    enabled: checked('enabled'),\n    dailyOperationStartTime: value('dailyOperationStartTime') || undefined,\n    newArticlesEnabled: checked('newArticlesEnabled'),",
  'SERIALIZE_GLOBAL_SCHEDULE_FIELD'
);
replaceOnce(
  'web/automation.js',
  '    <p class="hint">전체 기본값을 정한 뒤 각 블로그를 열어 개별 설정을 덮어쓸 수 있습니다. 언어 자동은 Blogger에 설정된 블로그 언어를 사용합니다.</p>',
  '    <p class="hint">전체 기본값을 정한 뒤 각 블로그를 열어 개별 설정을 덮어쓸 수 있습니다. 일일 자동운영 시작 시간은 전체 설정에서 조정하며, 언어 자동은 Blogger에 설정된 블로그 언어를 사용합니다.</p>',
  'UPDATE_AUTOMATION_HINT'
);
replaceOnce(
  'web/automation.js',
  "      <h3>전체 기본 설정</h3>\n      ${settingsFields()}",
  "      <h3>전체 기본 설정</h3>\n      ${globalScheduleFields()}\n      ${settingsFields()}",
  'RENDER_GLOBAL_SCHEDULE_FIELD'
);

replaceOnce(
  'web/build-stage.js',
  "      { label: '06:00 블로그 상태 자동 진단', status: 'active' },",
  "      { label: '설정 시간 블로그 상태 자동 진단', status: 'active' },",
  'ROADMAP_CONFIGURABLE_TIME'
);
replaceOnce(
  'tests/build-stage.test.mjs',
  "  assert.match(buildStage, /06:00 블로그 상태 자동 진단', status: 'active'/);",
  "  assert.match(buildStage, /설정 시간 블로그 상태 자동 진단', status: 'active'/);",
  'ROADMAP_TEST_CONFIGURABLE_TIME'
);

replaceOnce(
  'tests/automation-settings.test.mjs',
  "test('automatic content language follows Blogger locale while explicit setting wins', () => {",
  "test('daily operation defaults to 03:00 and accepts a management-center override', () => {\n  assert.equal(DEFAULT_AUTOMATION_SETTINGS.dailyOperationStartTime, '03:00');\n  assert.equal(normalizeAutomationSettings({}).dailyOperationStartTime, '03:00');\n  assert.equal(normalizeAutomationSettings({ dailyOperationStartTime: '07:30' }).dailyOperationStartTime, '07:30');\n  assert.throws(() => normalizeAutomationSettings({ dailyOperationStartTime: '25:00' }), /DAILY_OPERATION_START_TIME_INVALID/);\n});\n\ntest('automatic content language follows Blogger locale while explicit setting wins', () => {",
  'ADD_AUTOMATION_TIME_TEST'
);
replaceOnce(
  'tests/automation-settings.test.mjs',
  "  const preview = buildAutomationPreview(automation, '2026-08-29');\n  assert.deepEqual(preview.blogs[0].publishing.times, ['07:30', '08:15']);",
  "  const preview = buildAutomationPreview(automation, '2026-08-29');\n  assert.equal(preview.dailyOperationStartTime, '03:00');\n  assert.equal(preview.timezone, 'Asia/Seoul');\n  assert.deepEqual(preview.blogs[0].publishing.times, ['07:30', '08:15']);",
  'ADD_PREVIEW_TIME_TEST'
);

create('tests/daily-operation-schedule.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { isDailyOperationDue, localClock } from '../worker/lib/daily-operation-schedule.js';

test('daily operation is due at 03:00 Asia/Seoul only inside the five-minute poll window', () => {
  const settings = { dailyOperationStartTime: '03:00', timezone: 'Asia/Seoul' };
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:00:00Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:04:59Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:05:00Z')), false);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T17:59:00Z')), false);
});

test('daily operation follows a management-center time change', () => {
  const settings = { dailyOperationStartTime: '07:30', timezone: 'Asia/Seoul' };
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-29T22:30:00Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-29T18:00:00Z')), false);
});

test('local clock respects the configured timezone', () => {
  assert.deepEqual(localClock(new Date('2026-08-30T18:00:00Z'), 'Asia/Seoul'), { hour: 3, minute: 0, minutes: 180 });
});
`);

replaceOnce(
  '.github/workflows/deploy-orchestrator-service-binding.yml',
  "                && stage.includes('CURRENT_BUILD_PHASE = 2')",
  "                && stage.includes('CURRENT_BUILD_PHASE = 3')",
  'DEPLOY_VERIFY_PHASE3'
);
replaceOnce(
  '.github/workflows/deploy-orchestrator-service-binding.yml',
  "                && stage.includes(\"이미지 생성과 본문 중간 분산 배치', status: 'active'\")\n                && stage.includes(\"일일 운영 계획과 블로그 선택형 작업 화면', status: 'done'\")",
  "                && stage.includes(\"이미지 생성과 본문 중간 분산 배치', status: 'done'\")\n                && stage.includes(\"일일 운영 계획과 블로그 선택형 작업 화면', status: 'done'\")\n                && stage.includes(\"설정 시간 블로그 상태 자동 진단', status: 'active'\")",
  'DEPLOY_VERIFY_PHASE3_ROADMAP'
);

console.log('Phase 3 configurable daily operation time patch applied.');
