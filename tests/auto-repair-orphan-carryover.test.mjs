import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');

test('ready repair jobs without a daily slot are recovered as carryover candidates', () => {
  assert.match(source, /j\.daily_slot_id IS NULL/);
  assert.match(source, /'orphan_ready' AS candidate_source/);
  assert.match(source, /j\.status = 'ready'/);
  assert.match(source, /p\.job_id IS NULL/);
});

test('orphan repair carryover still reserves new-article capacity and respects the daily cap', () => {
  assert.match(source, /reservedNew = Number\(settings\.newArticlesEnabled \? settings\.newArticlesPerDay : 0\)/);
  assert.match(source, /COALESCE\(MAX\(slot_no\), 0\) AS max_slot/);
  assert.match(source, /position > Number\(settings\.maxPublishesPerDay \|\| 0\)/);
});

test('repair carryover keeps the original Blogger identity safety gate', () => {
  assert.match(source, /assertExistingIdentity/);
  assert.match(source, /bloggerPostId: String\(candidate\.blogger_post_id\)/);
  assert.match(source, /critic\.status !== 'PASS'/);
  assert.match(source, /Number\(critic\.score\) < 95/);
});
