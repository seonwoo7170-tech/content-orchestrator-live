export const PHASE1_REQUIREMENTS = Object.freeze([
  { key: 'blogger_connection', label: 'Blogger 연결' },
  { key: 'blog_list', label: '블로그 목록' },
  { key: 'writer_master_v45', label: 'Writer + Master v4.5' },
  { key: 'critic_structured', label: 'Critic 실제 검수' },
  { key: 'targeted_repair_final_critic', label: '부분 Repair + Final Critic' },
  { key: 'blogger_private_draft', label: 'Blogger 비공개 Draft 검증' }
]);

export const MASTER_V45_SHA256 = '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66';

export function createPhase1Snapshot(verifiedKeys = []) {
  const verified = new Set(verifiedKeys);
  const items = PHASE1_REQUIREMENTS.map((item) => ({ ...item, verified: verified.has(item.key) }));
  const completed = items.filter((item) => item.verified).length;
  return {
    completed,
    total: items.length,
    percent: Math.round((completed / items.length) * 100),
    items
  };
}

export function validateArticle(article) {
  if (!article || typeof article !== 'object') throw new Error('ARTICLE_REQUIRED');
  for (const key of ['title', 'html', 'searchDescription', 'language', 'topic']) {
    if (typeof article[key] !== 'string' || !article[key].trim()) throw new Error(`ARTICLE_${key.toUpperCase()}_REQUIRED`);
  }
  if (!Array.isArray(article.labels)) throw new Error('ARTICLE_LABELS_REQUIRED');
  if (!Array.isArray(article.sources)) throw new Error('ARTICLE_SOURCES_REQUIRED');
  return article;
}

export function validateCriticResult(result) {
  if (!result || typeof result !== 'object') throw new Error('CRITIC_RESULT_REQUIRED');
  if (!['PASS', 'FAIL'].includes(result.status)) throw new Error('CRITIC_STATUS_INVALID');
  if (!Array.isArray(result.issues)) throw new Error('CRITIC_ISSUES_REQUIRED');
  for (const issue of result.issues) {
    for (const key of ['code', 'severity', 'location', 'reason', 'repairInstruction']) {
      if (typeof issue?.[key] !== 'string' || !issue[key].trim()) throw new Error(`CRITIC_ISSUE_${key.toUpperCase()}_REQUIRED`);
    }
  }
  if (result.status === 'PASS' && result.issues.length !== 0) throw new Error('CRITIC_PASS_WITH_ISSUES');
  if (result.status === 'FAIL' && result.issues.length === 0) throw new Error('CRITIC_FAIL_WITHOUT_ISSUES');
  return result;
}

export function normalizeExistingRepairRequest(input) {
  if (!input || typeof input !== 'object') throw new Error('REQUEST_REQUIRED');
  const blogId = String(input.blogId || '').trim();
  const bloggerPostId = String(input.bloggerPostId || '').trim();
  if (!blogId) throw new Error('BLOG_ID_REQUIRED');
  if (!bloggerPostId) throw new Error('BLOGGER_POST_ID_REQUIRED');
  return {
    mode: 'repair_existing',
    blogId,
    bloggerPostId,
    targetUrl: input.targetUrl ? String(input.targetUrl) : null,
    instructions: input.instructions ? String(input.instructions) : null
  };
}
