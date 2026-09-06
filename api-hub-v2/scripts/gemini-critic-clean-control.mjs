import { critic } from '../src/lib/ai-routes.js';

const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) throw new Error('GEMINI_API_KEY_REQUIRED');

const article = {
  title: '윈도우에서 파일 이름 바꾸는 방법: 초보자를 위한 가장 쉬운 순서',
  html: `<p>윈도우에서 파일 이름을 바꾸는 가장 간단한 방법은 파일을 선택한 뒤 <strong>F2 키</strong>를 누르고 새 이름을 입력하는 것입니다. 키보드가 불편하다면 파일을 마우스 오른쪽 버튼으로 눌러 이름 바꾸기 메뉴를 이용해도 됩니다.</p>
<h2>파일 하나의 이름을 바꾸는 기본 방법</h2>
<p>먼저 파일 탐색기에서 이름을 바꿀 파일을 찾습니다. 파일을 한 번 클릭해 선택한 뒤 F2 키를 누르면 파일 이름 부분이 편집 상태로 바뀝니다. 원하는 이름을 입력하고 Enter 키를 누르면 변경이 완료됩니다.</p>
<p>마우스로 작업하고 싶다면 파일을 마우스 오른쪽 버튼으로 클릭한 뒤 이름 바꾸기 항목을 선택합니다. 이후 새 이름을 입력하고 Enter 키를 누르면 됩니다. 두 방법 모두 파일의 내용 자체를 바꾸는 작업은 아닙니다.</p>
<h2>이름을 바꿀 때 확인할 점</h2>
<p>파일 이름만 수정하려는 경우 확장자까지 억지로 바꿀 필요는 없습니다. 화면에 확장자가 표시되어 있다면 마지막의 점과 확장자 부분을 실수로 지우거나 다른 문자로 바꾸지 않았는지 확인하는 편이 좋습니다.</p>
<p>같은 폴더 안에는 완전히 같은 이름의 파일을 둘 수 없는 경우가 있으므로 이미 같은 이름이 있다면 다른 이름을 사용합니다. 이름을 정할 때는 나중에 검색하기 쉽도록 날짜나 문서의 용도를 짧게 넣는 것도 실용적입니다.</p>
<h2>이름 변경이 잘 안 될 때</h2>
<p>파일이 다른 프로그램에서 사용 중이라면 먼저 해당 프로그램에서 작업을 마친 뒤 다시 시도합니다. 회사나 학교에서 관리하는 PC처럼 사용 권한이 제한된 환경에서는 일부 위치의 파일 이름을 바꾸지 못할 수도 있습니다. 이때는 권한을 우회하려고 시스템 설정을 임의로 변경하기보다 파일의 위치와 사용 권한을 먼저 확인하는 편이 안전합니다.</p>
<h2>여러 파일을 정리할 때의 팁</h2>
<p>사진이나 문서가 많다면 먼저 별도 폴더에 모아 정리 기준을 정한 다음 이름을 바꾸는 것이 편합니다. 예를 들어 ‘여행-장소-순번’처럼 일정한 형식을 정하면 파일이 많아져도 찾기 쉬워집니다. 중요한 파일은 이름을 대량으로 변경하기 전에 복사본을 준비해 두면 실수를 되돌리기 쉽습니다.</p>
<section><h2>자주 묻는 질문</h2>
<h3>파일 이름을 바꾸면 파일 내용도 달라지나요?</h3><p>아닙니다. 일반적인 이름 변경은 파일을 식별하는 이름을 바꾸는 작업이며 문서나 사진의 실제 내용 자체를 편집하는 작업과는 다릅니다.</p>
<h3>F2 키가 작동하지 않으면 어떻게 하나요?</h3><p>파일을 마우스 오른쪽 버튼으로 클릭해 이름 바꾸기 메뉴를 사용하면 됩니다. 노트북의 기능키 설정에 따라 F2를 사용할 때 Fn 키를 함께 눌러야 하는 경우도 있습니다.</p></section>`,
  searchDescription: '윈도우에서 파일 이름을 바꾸는 기본 방법과 초보자가 실수하기 쉬운 부분을 F2 키와 마우스 메뉴 기준으로 쉽게 설명합니다.',
  labels: ['Windows', 'PC 초보자', '파일 관리'],
  sources: [],
  language: 'ko',
  topic: '윈도우 파일 이름 바꾸는 방법'
};

const result = await critic(
  {
    GEMINI_API_KEY: apiKey,
    GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite'
  },
  { article, stage: 'clean-control' },
  {
    async run() {
      throw new Error('WORKERS_AI_MUST_NOT_RUN_FOR_CRITIC');
    }
  },
  fetch
);

console.log(JSON.stringify({
  mode: 'critic-clean-control',
  provider: result.provider,
  model: result.model,
  status: result.status,
  score: result.score,
  issueCount: result.issues.length,
  issues: result.issues.map((issue) => ({
    code: String(issue.code || ''),
    severity: String(issue.severity || ''),
    location: String(issue.location || '')
  })),
  auditMode: result.auditMode,
  usage: result.usage,
  rolePrompt: result.rolePrompt,
  writes: false
}, null, 2));

if (result.provider !== 'google-gemini' || result.fallbackUsed) throw new Error('GEMINI_DEDICATED_CRITIC_NOT_USED');
if (result.status !== 'PASS' || result.issues.length !== 0 || result.score < 95) {
  throw new Error(`GEMINI_CLEAN_CONTROL_FALSE_POSITIVE:${result.status}:${result.score}:${result.issues.length}`);
}
