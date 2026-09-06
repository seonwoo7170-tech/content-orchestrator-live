import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMasterV45 } from '../src/lib/master-v45-bundle.js';
import { loadMasterV45RolePrompt, rolePromptDefinition } from '../src/lib/master-v45-role-prompts.js';

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function topLevelSections(text) {
  const matches = [...text.matchAll(/^# .+$/gm)];
  return matches.map((match, index) => ({
    heading: match[0].trim(),
    index: match.index,
    text: text.slice(match.index, index + 1 < matches.length ? matches[index + 1].index : text.length)
  }));
}

const EXPECTED = Object.freeze({
  writer: {
    size: 60075,
    sha256: 'd72c959ba73cfaffff6582889d522201bfb55de2a81f461585c0dc352251609e',
    sectionCount: 72
  },
  critic: {
    size: 65993,
    sha256: 'b9f1e03ab0bd6e65ae8206bfd8253083929677e16f3fda6d3c35ec2d50a077c5',
    sectionCount: 75
  },
  repair: {
    size: 64451,
    sha256: '10c9e4c2dd761e5c60e04394f8f904dde612539705ac65a2b74bd40544949b04',
    sectionCount: 75
  }
});

for (const role of ['writer', 'critic', 'repair']) {
  test(`${role} role prompt keeps the approved derived source fingerprint`, async () => {
    const result = await loadMasterV45RolePrompt(role);
    const expected = EXPECTED[role];
    assert.equal(utf8Bytes(result.sourceText), expected.size);
    assert.equal(result.meta.size, expected.size);
    assert.equal(result.meta.sha256, expected.sha256);
    assert.equal(result.meta.sectionCount, expected.sectionCount);
    assert.equal(result.meta.exactSourceSections, true);
    assert.equal(result.meta.runtimeClarification, 'structure-naturalness-v1');
    assert.ok(result.meta.effectiveSize > result.meta.size);
    assert.equal(utf8Bytes(result.text), result.meta.effectiveSize);
    assert.match(result.meta.effectiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(rolePromptDefinition(role).sha256, expected.sha256);
  });
}

test('all pinned source role-prompt sections remain unchanged Master v4.5 sections in original order', async () => {
  const master = await loadMasterV45();
  const sourceSections = topLevelSections(master);
  const sourceByHeading = new Map(sourceSections.map((section, index) => [section.heading, { ...section, order: index }]));

  for (const role of ['writer', 'critic', 'repair']) {
    const result = await loadMasterV45RolePrompt(role);
    const derivedSections = topLevelSections(result.sourceText);
    let previousOrder = -1;

    for (const section of derivedSections) {
      const source = sourceByHeading.get(section.heading);
      assert.ok(source, `${role}: missing source section ${section.heading}`);
      assert.equal(section.text, source.text, `${role}: source text changed in ${section.heading}`);
      assert.ok(source.order > previousOrder, `${role}: source section order changed at ${section.heading}`);
      previousOrder = source.order;
    }
  }
});

test('runtime structure-naturalness clarification is shared by Writer, Critic and Repair', async () => {
  for (const role of ['writer', 'critic', 'repair']) {
    const result = await loadMasterV45RolePrompt(role);
    assert.ok(!result.sourceText.includes('STRUCTURE NATURALNESS V1'));
    assert.ok(result.text.includes('STRUCTURE NATURALNESS V1'));
    assert.ok(result.text.includes('모든 소제목의 문구·개수·형식을 고정하는 템플릿이 아니다'));
    assert.ok(result.text.includes('H2/H3 제목 앞에 1., 2., 3. 등의 번호를 관성적으로 붙이지 않는다'));
    assert.ok(result.text.includes('실제 시간 순서, 작업 순서, 단계, 순위처럼 순서 자체가 의미를 가질 때만 사용한다'));
    assert.ok(result.text.includes('제목에 숫자나 N가지가 포함됐다는 이유만으로 모든 H2/H3를 번호형으로 만들지 않는다'));
  }
});

test('automation role prompts exclude interactive platform-selection sections', async () => {
  for (const role of ['writer', 'critic', 'repair']) {
    const { text } = await loadMasterV45RolePrompt(role);
    assert.ok(!text.includes('# 4. 최초 플랫폼 선택'));
    assert.ok(!text.includes('# 5. 플랫폼 명령'));
    assert.ok(!text.includes('# 64. 플랫폼별 최종 출력 — 티스토리'));
    assert.ok(!text.includes('# 66. 플랫폼별 최종 출력 — 공통 모드'));
  }
});
