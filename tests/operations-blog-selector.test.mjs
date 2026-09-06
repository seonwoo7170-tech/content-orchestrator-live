import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const operations = fs.readFileSync(new URL('../web/operations.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/operations.css', import.meta.url), 'utf8');

test('daily operations render one selected blog card with a dropdown', () => {
  assert.match(operations, /selectedBlogId/);
  assert.match(operations, /renderSelectedBlog/);
  assert.match(operations, /id="plan-blog-select"/);
  assert.match(operations, /작업 대상 블로그/);
  assert.match(operations, /planList\?\.addEventListener\('change'/);
  assert.match(css, /plan-blog-picker/);
});

test('overall daily counts stay based on all slots while only selected blog forms render', () => {
  assert.match(operations, /const newCount = slots\.filter/);
  assert.match(operations, /const repairCount = slots\.filter/);
  assert.match(operations, /const resolvedCount = slots\.filter/);
  assert.match(operations, /planList\.innerHTML = renderSelectedBlog\(groups\)/);
  assert.match(operations, /setState\(`\$\{resolvedCount\}\/\$\{slots\.length\} 작업 연결\$\{recoveryText\}`/);
});

test('daily operations display retry-wait and held recovery counts without raw errors', () => {
  assert.match(operations, /\/api\/operations\/recovery/);
  assert.match(operations, /재시도 대기/);
  assert.match(operations, /보류/);
  assert.match(operations, /recovery\?\.summary\?\.jobs/);
  assert.match(operations, /slot\.hold_reason \|\| slot\.last_error_code/);
});

test('management center exposes adaptive blog priority and selected daily workload', () => {
  assert.match(operations, /workloadByBlog/);
  assert.match(operations, /data\?\.workload\?\.decisions/);
  assert.match(operations, /우선순위/);
  assert.match(operations, /workload\.newArticles/);
  assert.match(operations, /workload\.repairs/);
  assert.match(operations, /리페어 우선/);
});
