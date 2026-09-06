import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');

test('auto publisher includes recent carryover plan dates instead of today only', () => {
  assert.match(source, /CARRYOVER_LOOKBACK_DAYS\s*=\s*2/);
  assert.match(source, /s\.plan_date BETWEEN date\(\?, \?\) AND \?/);
  assert.doesNotMatch(source, /WHERE s\.plan_date = \?/);
});

test('carryover outcomes include original plan date for diagnosis', () => {
  assert.match(source, /planDate: String\(candidate\.plan_date\)/);
});
