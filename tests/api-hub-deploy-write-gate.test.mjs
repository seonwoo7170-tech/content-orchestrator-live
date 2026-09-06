import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const generic = fs.readFileSync('.github/workflows/deploy-api-hub-v2.yml', 'utf8');
const managed = fs.readFileSync('.github/workflows/deploy-api-hub-v2-managed.yml', 'utf8');
const ids = [
  '2028653002689012296',
  '3842750331568707733',
  '5540565797560833468',
  '7741529904469657049',
  '6470344354760178454',
  '359287489505251041',
  '286230575079975521'
];

test('every production API Hub deployment preserves managed Blogger writes for all connected blogs', () => {
  for (const source of [generic, managed]) {
    assert.match(source, /BLOGGER_WRITES_ENABLED: 'true'/);
    assert.match(source, /BLOGGER_WRITE_MODE: managed_allowlist/);
    for (const id of ids) assert.match(source, new RegExp(id));
  }
});

test('generic API Hub deployment readbacks require managed writes instead of disabled writes', () => {
  assert.doesNotMatch(generic, /bloggerWritesEnabled !== false/);
  assert.doesNotMatch(generic, /bloggerWriteMode !== 'disabled'/);
  assert.match(generic, /bloggerWritesEnabled !== true/);
  assert.match(generic, /bloggerWriteMode !== 'managed_allowlist'/);
});

test('both API Hub deploy paths preserve the optional Free.ai fallback secret', () => {
  for (const source of [generic, managed]) {
    assert.match(source, /API_HUB_V2_FREE_AI_API_KEY/);
    assert.match(source, /FREE_AI_API_KEY/);
  }
});
