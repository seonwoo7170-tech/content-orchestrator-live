const CURRENT_BUILD_PHASE = 6;

const BUILD_ROADMAP = Object.freeze([
  {
    phase: 0,
    label: '기반 인프라',
    items: [
      { label: 'GitHub 저장소와 배포 구조', status: 'done' },
      { label: 'Cloudflare Workers · D1 · R2 기반', status: 'done' },
      { label: 'API Hub와 Blogger 연결', status: 'done' },
      { label: 'Secret 보호와 Blogger 쓰기 안전 게이트', status: 'done' }
    ]
  },
  {
    phase: 1,
    label: '콘텐츠 엔진',
    items: [
      { label: 'Writer → Critic → Targeted Repair → Final Critic', status: 'done' },
      { label: 'Master v4.5 기반 역할별 프롬프트', status: 'done' },
      { label: 'Natural Writing Linter와 품질 기준', status: 'done' },
      { label: '기존 발행글 Post ID 보존형 리페어', status: 'done' }
    ]
  },
  {
    phase: 2,
    label: '운영 자동화 · PWA · 이미지',
    items: [
      { label: '모바일 PWA 관리센터와 작업 큐', status: 'done' },
      { label: '블로그별 언어 · 운영 모드 · 자동화 설정', status: 'done' },
      { label: '이미지 생성과 본문 중간 분산 배치', status: 'done' },
      { label: '썸네일 무문자 원본 + 후킹문구 후처리', status: 'done' },
      { label: '승인 · 발행 · 자동발행 안전 게이트', status: 'done' },
      { label: '일일 운영 계획과 블로그 선택형 작업 화면', status: 'done' }
    ]
  },
  {
    phase: 3,
    label: '완전 자동 일일 운영',
    items: [
      { label: '설정 시간 블로그 상태 자동 진단', status: 'done' },
      { label: '신규 글 · 리페어 작업 자동 선택 및 실행', status: 'done' },
      { label: '실패 재시도 · 보류 · 운영 보고', status: 'done' },
      { label: '블로그별 우선순위와 일일 작업량 자동 조정', status: 'done' }
    ]
  },
  {
    phase: 4,
    label: 'GSC · GA4 · AdSense 데이터 운영',
    items: [
      { label: 'Google Search Console 검색 성과 수집', status: 'done' },
      { label: 'GA4 유입 · 참여도 데이터 수집', status: 'done' },
      { label: 'AdSense 수익 데이터 연계', status: 'done' },
      { label: '성과 기반 신규 · 리페어 · 유지 우선순위 결정', status: 'done' }
    ]
  },
  {
    phase: 5,
    label: '콘텐츠 전략 · 클러스터 · 내부링크',
    items: [
      { label: '검색의도 · 키워드 · 주제 후보 관리', status: 'done' },
      { label: '콘텐츠 클러스터와 허브 구조', status: 'done' },
      { label: '내부링크 자동 추천 · 연결', status: 'done' },
      { label: '중복 · 카니발리제이션 · 통합 · 리페어 판단', status: 'done' },
      { label: '아이디어뱅크와 적용 흐름', status: 'done' }
    ]
  },
  {
    phase: 6,
    label: '외부 유입 자동화',
    items: [
      { label: '외부 유입 채널별 콘텐츠 변환', status: 'done' },
      { label: 'Pinterest 등 채널 배포 자동화', status: 'active' },
      { label: '원문과 외부 콘텐츠 연결 추적', status: 'done' },
      { label: '유입 성과 기반 채널 운영 최적화', status: 'done' }
    ]
  },
  {
    phase: 7,
    label: '네이버 전용 엔진 · 관리센터',
    items: [
      { label: '네이버 블로그 전용 Writer · Critic · Repair', status: 'planned' },
      { label: '네이버 검색의도와 모바일 체류형 구성', status: 'planned' },
      { label: '네이버 전용 승인 · 발행 운영', status: 'planned' },
      { label: '쇼핑형 · 브랜드형 수익화 콘텐츠 대응', status: 'planned' }
    ]
  },
  {
    phase: 8,
    label: '영상 재활용 자동화',
    items: [
      { label: '블로그 글 → 영상 대본 변환', status: 'planned' },
      { label: '씬 구성 · 이미지 생성 · TTS', status: 'planned' },
      { label: '자막 · 합성 · 최종 영상 제작', status: 'planned' },
      { label: '숏폼 · 롱폼 채널별 업로드 흐름', status: 'planned' }
    ]
  },
  {
    phase: 9,
    label: '통합 운영센터',
    items: [
      { label: 'Blogger · 네이버 · 외부 유입 · 영상 통합 관제', status: 'planned' },
      { label: '채널별 작업 · 승인 · 오류 상태 통합', status: 'planned' },
      { label: '통합 KPI와 우선순위 판단', status: 'planned' },
      { label: '하나의 관리센터에서 전체 운영 제어', status: 'planned' }
    ]
  }
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getPhaseProgress(item) {
  const total = item.items.length;
  const done = item.items.filter((detail) => detail.status === 'done').length;
  const active = item.items.filter((detail) => detail.status === 'active').length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const status = done === total && total > 0 ? 'done' : done > 0 || active > 0 ? 'current' : 'planned';
  return { total, done, active, percent, status };
}

function renderItemStatus(status) {
  if (status === 'done') return '<span class="phase-item-status done">완료</span>';
  if (status === 'active') return '<span class="phase-item-status active">진행 중</span>';
  return '<span class="phase-item-status planned">예정</span>';
}

function renderBuildRoadmap() {
  const phaseItems = document.querySelector('#phase-items');
  const phaseCount = document.querySelector('#phase-count');
  const phaseBar = document.querySelector('#phase-bar');
  if (!phaseItems || !phaseCount || !phaseBar) return;

  const openPhases = new Set([...phaseItems.querySelectorAll('details[open][data-build-phase]')].map((node) => String(node.dataset.buildPhase)));
  const maxPhase = BUILD_ROADMAP.at(-1)?.phase ?? 9;
  const current = BUILD_ROADMAP.find((item) => item.phase === CURRENT_BUILD_PHASE);
  const currentProgress = current ? getPhaseProgress(current) : null;
  phaseCount.textContent = currentProgress
    ? `Phase ${CURRENT_BUILD_PHASE} / ${maxPhase} · ${currentProgress.done}/${currentProgress.total}`
    : `Phase ${CURRENT_BUILD_PHASE} / ${maxPhase}`;
  phaseBar.style.width = `${Math.round((CURRENT_BUILD_PHASE / Math.max(maxPhase, 1)) * 100)}%`;
  phaseItems.dataset.buildRoadmap = 'true';
  phaseItems.innerHTML = BUILD_ROADMAP.map((item) => {
    const progress = getPhaseProgress(item);
    const badge = progress.status === 'done'
      ? '<span class="status-pill success">완료</span>'
      : progress.status === 'current'
        ? '<span class="status-pill active">진행 중</span>'
        : '<span class="status-pill neutral">예정</span>';
    const activeText = progress.active > 0 ? ` · ${progress.active} 진행 중` : '';
    const details = item.items.map((detail) => `
      <li class="phase-detail-item ${detail.status}">
        <span>${escapeHtml(detail.label)}</span>
        ${renderItemStatus(detail.status)}
      </li>`).join('');
    const shouldOpen = openPhases.has(String(item.phase)) ? ' open' : '';
    return `
      <details class="phase-entry ${progress.status}" data-build-phase="${item.phase}"${shouldOpen}>
        <summary class="phase-row ${progress.status === 'done' ? 'done' : ''}">
          <span class="dot"></span>
          <span class="phase-title"><strong>Phase ${item.phase}</strong> · ${escapeHtml(item.label)}</span>
          <span class="phase-row-actions">${badge}<span class="phase-toggle"><span class="phase-more">자세히 보기</span><span class="phase-less">접기</span> <b>⌄</b></span></span>
          <span class="phase-progress-summary">${progress.done}/${progress.total} 완료${activeText} · ${progress.percent}%</span>
          <span class="phase-progress-track" aria-label="Phase ${item.phase} 진행률 ${progress.percent}%"><span style="width:${progress.percent}%"></span></span>
        </summary>
        <div class="phase-details"><ul>${details}</ul></div>
      </details>`;
  }).join('');
}

renderBuildRoadmap();

const phaseItems = document.querySelector('#phase-items');
if (phaseItems) {
  const observer = new MutationObserver(() => {
    if (!phaseItems.querySelector(`[data-build-phase="${CURRENT_BUILD_PHASE}"]`)) renderBuildRoadmap();
  });
  observer.observe(phaseItems, { childList: true, subtree: true });
}

window.addEventListener('load', renderBuildRoadmap);