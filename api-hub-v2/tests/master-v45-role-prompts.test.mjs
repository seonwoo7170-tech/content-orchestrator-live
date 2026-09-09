import test from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_V45 } from '../src/lib/contracts.js';
import { loadMasterV45 } from '../src/lib/master-v45-bundle.js';
import { loadMasterV45RolePrompt, rolePromptDefinition } from '../src/lib/master-v45-role-prompts.js';

function utf8Size(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function topLevelSectionCount(text) {
  return [...String(text || '').matchAll(/^# .+$/gm)].length;
}

for (const role of ['writer', 'critic', 'repair']) {
  test(`${role} uses the exact full integrated Master v4.5`, async () => {
    const master = await loadMasterV45();
    const result = await loadMasterV45RolePrompt(role);
    const definition = rolePromptDefinition(role);

    assert.equal(result.sourceText, master);
    assert.equal(result.text, master);
    assert.equal(utf8Size(result.text), MASTER_V45.size);
    assert.equal(result.meta.size, MASTER_V45.size);
    assert.equal(result.meta.sha256, MASTER_V45.sha256);
    assert.equal(result.meta.effectiveSize, MASTER_V45.size);
    assert.equal(result.meta.effectiveSha256, MASTER_V45.sha256);
    assert.equal(result.meta.sourceMasterSize, MASTER_V45.size);
    assert.equal(result.meta.sourceMasterSha256, MASTER_V45.sha256);
    assert.equal(result.meta.sectionCount, topLevelSectionCount(master));
    assert.equal(result.meta.exactSourceSections, true);
    assert.equal(result.meta.exactFullMaster, true);
    assert.equal(result.meta.integratedMaster, true);
    assert.equal(result.meta.runtimeClarification, null);
    assert.equal(definition.fileName, MASTER_V45.fileName);
    assert.equal(definition.size, MASTER_V45.size);
    assert.equal(definition.sha256, MASTER_V45.sha256);
    assert.equal(definition.exactFullMaster, true);
    assert.equal(definition.integratedMaster, true);
  });
}

test('all three automation roles share one byte-identical integrated Master source', async () => {
  const writer = await loadMasterV45RolePrompt('writer');
  const critic = await loadMasterV45RolePrompt('critic');
  const repair = await loadMasterV45RolePrompt('repair');
  assert.equal(writer.text, critic.text);
  assert.equal(critic.text, repair.text);
  assert.equal(writer.meta.sha256, MASTER_V45.sha256);
});

test('integrated prompt restores the platform and common-mode sections that role pruning removed', async () => {
  const { text } = await loadMasterV45RolePrompt('writer');
  assert.ok(text.includes('# 4. 최초 플랫폼 선택'));
  assert.ok(text.includes('# 5. 플랫폼 명령'));
  assert.ok(text.includes('# 64. 플랫폼별 최종 출력 — 티스토리'));
  assert.ok(text.includes('# 66. 플랫폼별 최종 출력 — 공통 모드'));
});

test('invalid automation role still fails closed', () => {
  assert.throws(() => rolePromptDefinition('publisher'), /MASTER_V45_ROLE_INVALID/);
});
