import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MASTER_V45_SHA256 } from '../worker/lib/contracts.js';

test('Master v4.5 runtime integrity pin is exact', () => {
  const manifest = JSON.parse(readFileSync('prompts/master-v4.5.integrity.json', 'utf8'));
  assert.equal(manifest.sha256, MASTER_V45_SHA256);
  assert.equal(manifest.sizeBytes, 93282);
  assert.equal(manifest.runtimeOwner, 'API Hub');
});
