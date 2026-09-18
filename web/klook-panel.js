import { adminApi, isAdminConnected } from './admin-session.js';

const fileInput = document.querySelector('#klook-csv-file');
const uploadButton = document.querySelector('#klook-upload');
const refreshButton = document.querySelector('#klook-refresh-coverage');
const stateEl = document.querySelector('#klook-state');
const coverageList = document.querySelector('#klook-coverage-list');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setState(message, tone = 'neutral') {
  if (!stateEl) return;
  stateEl.textContent = message;
  stateEl.className = `status-pill ${tone}`;
}

function renderCoverage(cities) {
  if (!coverageList) return;
  if (!Array.isArray(cities) || cities.length === 0) {
    coverageList.innerHTML = '<p class="muted">현황 정보가 없습니다.</p>';
    return;
  }
  coverageList.innerHTML = cities.map((city) => `
    <div class="plan-slot ${city.productCount > 0 ? 'resolved' : ''}">
      <span>${escapeHtml(city.cityNameKo)} (${escapeHtml(city.cityNameEn)})</span>
      <strong>${city.productCount > 0 ? `${city.productCount}개 상품` : '비어있음'}</strong>
    </div>`).join('');
}

export async function loadKlookCoverage() {
  if (!isAdminConnected()) {
    setState('관리 연결 필요');
    coverageList.innerHTML = '<p class="muted">관리 연결 후 확인할 수 있습니다.</p>';
    return;
  }
  setState('불러오는 중', 'active');
  try {
    const data = await adminApi('/api/operations/klook/coverage');
    renderCoverage(data?.cities);
    const emptyCount = (data?.cities || []).filter((city) => city.productCount === 0).length;
    setState(emptyCount > 0 ? `${emptyCount}개 도시 비어있음` : '모든 도시 커버됨', emptyCount > 0 ? 'active' : 'success');
  } catch (error) {
    setState('조회 실패', 'danger');
    coverageList.innerHTML = `<p class="job-error">현황 조회 실패: ${escapeHtml(error.message)}</p>`;
  }
}

uploadButton?.addEventListener('click', async () => {
  const file = fileInput?.files?.[0];
  if (!file) {
    setState('CSV 파일을 선택해주세요', 'danger');
    return;
  }
  uploadButton.disabled = true;
  setState('업로드 중', 'active');
  try {
    const csvText = await file.text();
    const result = await adminApi('/api/operations/klook/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csvText
    });
    setState(`${result.imported}개 반영 · ${result.skipped}개 건너뜀`, 'success');
    if (fileInput) fileInput.value = '';
    await loadKlookCoverage();
  } catch (error) {
    setState('업로드 실패', 'danger');
    coverageList.innerHTML = `<p class="job-error">업로드 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    uploadButton.disabled = false;
  }
});

refreshButton?.addEventListener('click', loadKlookCoverage);
window.addEventListener('orchestrator:admin-session', loadKlookCoverage);
loadKlookCoverage();
