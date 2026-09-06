import { MASTER_V45 } from './contracts.js';
import { loadMasterV45 } from './master-v45-bundle.js';

const ROLE_DEFINITIONS = Object.freeze({
  writer: Object.freeze({
    fileName: 'master-v45-writer.md',
    size: 60075,
    sha256: 'd72c959ba73cfaffff6582889d522201bfb55de2a81f461585c0dc352251609e',
    headings: Object.freeze([
      '# 한글·영문 공통 블로그 마스터 지침', '# 역할', '# 최종 목적', '# 0-1. 규칙 충돌 해결 우선순위',
      '# 2. 사용자 언어 규칙', '# 6. 개인정보 및 작성자 규칙', '# 7. 공통 작성 원칙', '# 8. E-E-A-T 및 실질적 추가가치 강화 규칙',
      '# 22. 좋은 주제 공식', '# 24. Google 콘텐츠 핵심 원칙', '# 25. 금지 사항', '# 26. 기사 길이', '# 27. 사실 검증',
      '# 28. 출처 우선순위', '# 29. YMYL 강화 규칙', '# 30. 기사 기본 작성 원칙', '# 31. Answer First 원칙', '# 32. 글 유형별 본문 구조',
      '# 33. 제목 규칙', '# 34. 최종 제목 선택', '# 35. Meta Description / 검색 설명', '# 36. Permalink', '# 37. Tags / Labels / Keywords',
      '# 38. 공통 HTML 원칙', '# 39. H1 공통 규칙', '# 40. 플랫폼별 제목 처리', '# 41. Blogger 문단 HTML', '# 42. H2 / H3', '# 43. 목차',
      '# 44. 이미지 규칙', '# 45. Hero Image', '# 46. 본문 이미지', '# 47. Key Takeaways', '# 48. 인용문', '# 49. Fact Check', '# 50. 비교·데이터 표',
      '# 51. 내부 링크', '# 52. 외부 링크', '# 53. Q&A', '# 54. Sources and Methodology', '# 55. 하단 작성자 정보', '# 56. Discover 규칙',
      '# 57. 동일 글 중복 게시 주의', '# 58. STEP 1 — 검색 분석 + 기사 아웃라인', '# 59. STEP 2 — HTML 구조 설계', '# 60. STEP 3 — 완성형 HTML 전체 출력',
      '# 61. STEP 3 전체 HTML 기본 순서', '# 62. 최종 HTML 기본 구조', '# 63. STEP 3 종료', '# 65. 플랫폼별 최종 출력 — Google Blogger / Blogspot',
      '# 67. 최종 HTML에 플랫폼 메타데이터를 넣지 않는다', '# 75. 블로그 플랫폼과 검색엔진을 혼동하지 않는다', '# 76. 플랫폼별 내용 품질 차이를 만들지 않는다',
      '# 79. 최종 핵심 규칙', '# 80. 통합본 운용 원칙', '# 81. 최종 목표', '# 82. 실행 가능 범위 및 작업 결과 정직성',
      '# 83. 사이트 문맥 및 기존 콘텐츠 구조 확인', '# 85. 전체 공개 글 중복 및 검색 의도 충돌 검사', '# 86. Primary Search Intent 집중 규칙',
      '# 87. 포커스 키워드와 관련 용어 사용 규칙', '# 88. 최신 자료 날짜 해석 규칙', '# 89. 출처 간 차이와 충돌 처리',
      '# 90. Google AdSense 및 광고·제휴 콘텐츠 원칙', '# 91. 자연스러운 문체 및 자동 생성 흔적 방지', '# 92. 첫 화면 직접 답변 강화',
      '# 93. CTA 및 다음 행동 설계', '# 94. 내부링크 및 콘텐츠 클러스터 강화', '# 95. HTML 접근성 및 모바일 안정성 강화',
      '# 96. 비교·가이드·비용형 콘텐츠의 실행 가능성', '# 97. 체크리스트·Q&A 선택 적용 규칙', '# 97-1. 미완성 템플릿 토큰 발행 금지'
    ])
  }),
  critic: Object.freeze({
    fileName: 'master-v45-critic.md',
    size: 65993,
    sha256: 'b9f1e03ab0bd6e65ae8206bfd8253083929677e16f3fda6d3c35ec2d50a077c5',
    headings: Object.freeze([
      '# 한글·영문 공통 블로그 마스터 지침', '# 최종 목적', '# 0-1. 규칙 충돌 해결 우선순위', '# 2. 사용자 언어 규칙',
      '# 6. 개인정보 및 작성자 규칙', '# 7. 공통 작성 원칙', '# 8. E-E-A-T 및 실질적 추가가치 강화 규칙', '# 9. 최종 검수 실패 시 재작성 규칙',
      '# 24. Google 콘텐츠 핵심 원칙', '# 25. 금지 사항', '# 26. 기사 길이', '# 27. 사실 검증', '# 28. 출처 우선순위', '# 29. YMYL 강화 규칙',
      '# 30. 기사 기본 작성 원칙', '# 31. Answer First 원칙', '# 32. 글 유형별 본문 구조', '# 33. 제목 규칙', '# 34. 최종 제목 선택',
      '# 35. Meta Description / 검색 설명', '# 36. Permalink', '# 37. Tags / Labels / Keywords', '# 38. 공통 HTML 원칙', '# 39. H1 공통 규칙',
      '# 40. 플랫폼별 제목 처리', '# 41. Blogger 문단 HTML', '# 42. H2 / H3', '# 43. 목차', '# 44. 이미지 규칙', '# 45. Hero Image', '# 46. 본문 이미지',
      '# 47. Key Takeaways', '# 48. 인용문', '# 49. Fact Check', '# 50. 비교·데이터 표', '# 51. 내부 링크', '# 52. 외부 링크', '# 53. Q&A',
      '# 54. Sources and Methodology', '# 55. 하단 작성자 정보', '# 56. Discover 규칙', '# 59. STEP 2 — HTML 구조 설계', '# 60. STEP 3 — 완성형 HTML 전체 출력',
      '# 61. STEP 3 전체 HTML 기본 순서', '# 62. 최종 HTML 기본 구조', '# 65. 플랫폼별 최종 출력 — Google Blogger / Blogspot',
      '# 67. 최종 HTML에 플랫폼 메타데이터를 넣지 않는다', '# 68. STEP 4 — 최종 점검', '# 69. STEP 4 수정 필요 사항', '# 70. 최종 점검 강제 재작성 규칙',
      '# 75. 블로그 플랫폼과 검색엔진을 혼동하지 않는다', '# 76. 플랫폼별 내용 품질 차이를 만들지 않는다', '# 79. 최종 핵심 규칙',
      '# 80. 통합본 운용 원칙', '# 81. 최종 목표', '# 82. 실행 가능 범위 및 작업 결과 정직성', '# 83. 사이트 문맥 및 기존 콘텐츠 구조 확인',
      '# 85. 전체 공개 글 중복 및 검색 의도 충돌 검사', '# 86. Primary Search Intent 집중 규칙', '# 87. 포커스 키워드와 관련 용어 사용 규칙',
      '# 88. 최신 자료 날짜 해석 규칙', '# 89. 출처 간 차이와 충돌 처리', '# 90. Google AdSense 및 광고·제휴 콘텐츠 원칙',
      '# 91. 자연스러운 문체 및 자동 생성 흔적 방지', '# 92. 첫 화면 직접 답변 강화', '# 93. CTA 및 다음 행동 설계',
      '# 94. 내부링크 및 콘텐츠 클러스터 강화', '# 95. HTML 접근성 및 모바일 안정성 강화', '# 96. 비교·가이드·비용형 콘텐츠의 실행 가능성',
      '# 97. 체크리스트·Q&A 선택 적용 규칙', '# 97-1. 미완성 템플릿 토큰 발행 금지', '# 98. 발행 전 품질검사 자동 수정 원칙',
      '# 99. 실제 공개·수정 작업 후 검증 규칙', '# 100. 보고 및 성과 수치 정직성', '# 101. 최종 무충돌 실행 게이트'
    ])
  }),
  repair: Object.freeze({
    fileName: 'master-v45-repair.md',
    size: 64451,
    sha256: '10c9e4c2dd761e5c60e04394f8f904dde612539705ac65a2b74bd40544949b04',
    headings: Object.freeze([
      '# 한글·영문 공통 블로그 마스터 지침', '# 최종 목적', '# 0-1. 규칙 충돌 해결 우선순위', '# 2. 사용자 언어 규칙',
      '# 6. 개인정보 및 작성자 규칙', '# 7. 공통 작성 원칙', '# 8. E-E-A-T 및 실질적 추가가치 강화 규칙', '# 9. 최종 검수 실패 시 재작성 규칙',
      '# 24. Google 콘텐츠 핵심 원칙', '# 25. 금지 사항', '# 26. 기사 길이', '# 27. 사실 검증', '# 28. 출처 우선순위', '# 29. YMYL 강화 규칙',
      '# 30. 기사 기본 작성 원칙', '# 31. Answer First 원칙', '# 32. 글 유형별 본문 구조', '# 33. 제목 규칙', '# 34. 최종 제목 선택',
      '# 35. Meta Description / 검색 설명', '# 36. Permalink', '# 37. Tags / Labels / Keywords', '# 38. 공통 HTML 원칙', '# 39. H1 공통 규칙',
      '# 40. 플랫폼별 제목 처리', '# 41. Blogger 문단 HTML', '# 42. H2 / H3', '# 43. 목차', '# 44. 이미지 규칙', '# 45. Hero Image', '# 46. 본문 이미지',
      '# 47. Key Takeaways', '# 48. 인용문', '# 49. Fact Check', '# 50. 비교·데이터 표', '# 51. 내부 링크', '# 52. 외부 링크', '# 53. Q&A',
      '# 54. Sources and Methodology', '# 55. 하단 작성자 정보', '# 56. Discover 규칙', '# 57. 동일 글 중복 게시 주의', '# 58. STEP 1 — 검색 분석 + 기사 아웃라인',
      '# 59. STEP 2 — HTML 구조 설계', '# 60. STEP 3 — 완성형 HTML 전체 출력', '# 61. STEP 3 전체 HTML 기본 순서', '# 62. 최종 HTML 기본 구조',
      '# 63. STEP 3 종료', '# 65. 플랫폼별 최종 출력 — Google Blogger / Blogspot', '# 67. 최종 HTML에 플랫폼 메타데이터를 넣지 않는다',
      '# 69. STEP 4 수정 필요 사항', '# 70. 최종 점검 강제 재작성 규칙', '# 75. 블로그 플랫폼과 검색엔진을 혼동하지 않는다',
      '# 76. 플랫폼별 내용 품질 차이를 만들지 않는다', '# 79. 최종 핵심 규칙', '# 80. 통합본 운용 원칙', '# 81. 최종 목표',
      '# 82. 실행 가능 범위 및 작업 결과 정직성', '# 83. 사이트 문맥 및 기존 콘텐츠 구조 확인', '# 85. 전체 공개 글 중복 및 검색 의도 충돌 검사',
      '# 86. Primary Search Intent 집중 규칙', '# 87. 포커스 키워드와 관련 용어 사용 규칙', '# 88. 최신 자료 날짜 해석 규칙',
      '# 89. 출처 간 차이와 충돌 처리', '# 90. Google AdSense 및 광고·제휴 콘텐츠 원칙', '# 91. 자연스러운 문체 및 자동 생성 흔적 방지',
      '# 92. 첫 화면 직접 답변 강화', '# 93. CTA 및 다음 행동 설계', '# 94. 내부링크 및 콘텐츠 클러스터 강화',
      '# 95. HTML 접근성 및 모바일 안정성 강화', '# 96. 비교·가이드·비용형 콘텐츠의 실행 가능성', '# 97. 체크리스트·Q&A 선택 적용 규칙',
      '# 97-1. 미완성 템플릿 토큰 발행 금지', '# 98. 발행 전 품질검사 자동 수정 원칙', '# 101. 최종 무충돌 실행 게이트'
    ])
  })
});

const RUNTIME_EDITORIAL_CLARIFICATION = `\n\n--- RUNTIME EDITORIAL CLARIFICATION — STRUCTURE NATURALNESS V1 ---\n이 보강 규칙은 Master v4.5의 #32 글 유형별 본문 구조와 #42 H2 / H3를 해석하는 자동화 규칙이며, 기존 안전·사실 검증·플랫폼·언어 규칙을 변경하지 않는다.\n- 글 유형별 구조는 검색 의도에 맞는 정보 흐름을 선택하기 위한 기본 골격이지, 모든 소제목의 문구·개수·형식을 고정하는 템플릿이 아니다. 독자가 핵심 답을 더 빨리 얻을 수 있다면 섹션을 생략·통합·재배열할 수 있다.\n- 같은 블로그에서도 모든 글에 동일한 섹션 수, 동일한 순서, 동일한 문장 패턴을 기계적으로 반복하지 않는다.\n- H2/H3 제목 앞에 1., 2., 3. 등의 번호를 관성적으로 붙이지 않는다. 번호형 제목은 실제 시간 순서, 작업 순서, 단계, 순위처럼 순서 자체가 의미를 가질 때만 사용한다.\n- 제목에 숫자나 N가지가 포함됐다는 이유만으로 모든 H2/H3를 번호형으로 만들지 않는다. 순서 의존성이 없는 설명·원인·비교·FAQ 등의 섹션은 자연스러운 제목을 우선한다.\n- 번호형 구조가 필요한 경우에도 전체 글을 불필요하게 같은 패턴으로 통일하지 않는다.\n- 검수 단계에서는 불필요한 연속 번호형 H2/H3와 기계적인 섹션 반복을 실제 결함으로 검사하되, 진짜 단계·순서·랭킹에는 번호 사용을 허용한다.\n- Repair 단계에서는 이 규칙 위반으로 정확히 지적된 제목/섹션만 최소 수정하고 다른 정상 섹션은 보존한다.\n--- END RUNTIME EDITORIAL CLARIFICATION ---`;

const cache = new Map();

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function splitTopLevelSections(master) {
  const matches = [...master.matchAll(/^# .+$/gm)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = match[0].trim();
    if (sections.has(heading)) throw Object.assign(new Error('MASTER_V45_DUPLICATE_HEADING'), { status: 500 });
    const end = index + 1 < matches.length ? matches[index + 1].index : master.length;
    sections.set(heading, master.slice(match.index, end));
  }
  return sections;
}

export function rolePromptDefinition(role) {
  const definition = ROLE_DEFINITIONS[String(role || '').trim()];
  if (!definition) throw Object.assign(new Error('MASTER_V45_ROLE_INVALID'), { status: 500 });
  return definition;
}

export async function loadMasterV45RolePrompt(role) {
  const key = String(role || '').trim();
  if (cache.has(key)) return cache.get(key);

  const definition = rolePromptDefinition(key);
  const master = await loadMasterV45();
  const sections = splitTopLevelSections(master);
  const selected = [];
  let previousIndex = -1;
  const orderedHeadings = [...sections.keys()];

  for (const heading of definition.headings) {
    const section = sections.get(heading);
    if (!section) throw Object.assign(new Error('MASTER_V45_ROLE_SECTION_MISSING'), { status: 500, meta: { role: key, heading } });
    const index = orderedHeadings.indexOf(heading);
    if (index <= previousIndex) throw Object.assign(new Error('MASTER_V45_ROLE_ORDER_INVALID'), { status: 500, meta: { role: key, heading } });
    previousIndex = index;
    selected.push(section);
  }

  const sourceText = selected.join('');
  const sourceBytes = utf8Bytes(sourceText);
  if (sourceBytes.byteLength !== definition.size) {
    throw Object.assign(new Error('MASTER_V45_ROLE_SIZE_MISMATCH'), { status: 500, meta: { role: key, expected: definition.size, actual: sourceBytes.byteLength } });
  }
  const sourceDigest = await sha256Hex(sourceBytes);
  if (sourceDigest !== definition.sha256) {
    throw Object.assign(new Error('MASTER_V45_ROLE_SHA256_MISMATCH'), { status: 500, meta: { role: key, expected: definition.sha256, actual: sourceDigest } });
  }

  const text = `${sourceText}${RUNTIME_EDITORIAL_CLARIFICATION}`;
  const effectiveBytes = utf8Bytes(text);
  const effectiveSha256 = await sha256Hex(effectiveBytes);

  const result = Object.freeze({
    text,
    sourceText,
    meta: Object.freeze({
      role: key,
      fileName: definition.fileName,
      size: definition.size,
      sha256: definition.sha256,
      sourceMasterSha256: MASTER_V45.sha256,
      sourceMasterSize: MASTER_V45.size,
      sectionCount: definition.headings.length,
      exactSourceSections: true,
      runtimeClarification: 'structure-naturalness-v1',
      effectiveSize: effectiveBytes.byteLength,
      effectiveSha256
    })
  });
  cache.set(key, result);
  return result;
}

export async function masterV45RolePromptRuntimeStatus() {
  const output = {};
  for (const role of ['writer', 'critic', 'repair']) {
    output[role] = (await loadMasterV45RolePrompt(role)).meta;
  }
  return output;
}
