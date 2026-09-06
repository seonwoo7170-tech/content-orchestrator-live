const BLOCK_PATTERNS = Object.freeze([
  { code: 'PLACEHOLDER_TODO', pattern: /\b(?:TODO|TBD|FIXME)\b/i, message: '작성 중 표식이 본문에 남아 있습니다.' },
  { code: 'PLACEHOLDER_LOREM', pattern: /\blorem\s+ipsum\b/i, message: '샘플 문구가 본문에 남아 있습니다.' },
  { code: 'PLACEHOLDER_INSERT', pattern: /\[(?:insert|add|replace|작성|삽입|추가)[^\]]{0,80}\]/i, message: '치환되지 않은 자리표시자가 남아 있습니다.' },
  { code: 'CITATION_PLACEHOLDER', pattern: /\[(?:citation needed|source needed|출처 필요|근거 필요)\]/i, message: '확인되지 않은 출처 자리표시자가 남아 있습니다.' },
  { code: 'UNSAFE_JAVASCRIPT_URL', pattern: /(?:href|src)\s*=\s*["']\s*javascript:/i, message: '실행형 javascript URL이 포함되어 있습니다.' },
  { code: 'UNSAFE_DATA_URL', pattern: /href\s*=\s*["']\s*data:/i, message: '링크에 data URL이 포함되어 있습니다.' }
]);

const WARN_PATTERNS = Object.freeze([
  { code: 'EMPTY_LINK', pattern: /href\s*=\s*["']\s*["']/i, message: '비어 있는 링크가 있습니다.' },
  { code: 'PLACEHOLDER_EXAMPLE_DOMAIN', pattern: /https?:\/\/(?:www\.)?example\.(?:com|org|net)\b/i, message: '예시용 도메인이 남아 있을 수 있습니다.' }
]);

function text(value) {
  return String(value ?? '').trim();
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingRows(html) {
  const rows = [];
  const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    rows.push({ level: Number(match[1]), title: stripTags(match[2]).toLowerCase() });
  }
  return rows;
}

function issue(code, severity, message, location = 'article') {
  return { code, severity, message, location };
}

function articleContractIssues(article) {
  const issues = [];
  if (!article || typeof article !== 'object') return [issue('ARTICLE_REQUIRED', 'block', '글 결과가 없습니다.')];
  for (const key of ['title', 'html', 'searchDescription', 'language', 'topic']) {
    if (!text(article[key])) issues.push(issue(`ARTICLE_${key.toUpperCase()}_REQUIRED`, 'block', `${key} 값이 비어 있습니다.`, key));
  }
  if (!Array.isArray(article.labels)) issues.push(issue('ARTICLE_LABELS_REQUIRED', 'block', 'labels 배열이 없습니다.', 'labels'));
  if (!Array.isArray(article.sources)) issues.push(issue('ARTICLE_SOURCES_REQUIRED', 'block', 'sources 배열이 없습니다.', 'sources'));
  return issues;
}

export function runDeterministicQualityGate(article) {
  const issues = articleContractIssues(article);
  if (!article || typeof article !== 'object') {
    return { version: 'smileseon-deterministic-qa.v1', status: 'BLOCK', issues, checks: { contract: false } };
  }

  const html = String(article.html || '');
  const combined = `${article.title || ''}\n${article.searchDescription || ''}\n${html}`;

  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(combined)) issues.push(issue(rule.code, 'block', rule.message, 'content'));
  }
  for (const rule of WARN_PATTERNS) {
    if (rule.pattern.test(combined)) issues.push(issue(rule.code, 'warn', rule.message, 'content'));
  }

  if (/<script\b/i.test(html)) {
    issues.push(issue('ARTICLE_SCRIPT_TAG_BLOCKED', 'block', '본문에는 실행 가능한 script 태그를 넣지 않습니다. 구조화데이터는 별도 검증 단계에서 관리합니다.', 'html'));
  }
  if (/<iframe\b/i.test(html)) {
    issues.push(issue('ARTICLE_IFRAME_REVIEW', 'warn', 'iframe이 포함되어 있어 게시 전 확인이 필요합니다.', 'html'));
  }

  const headings = headingRows(html);
  const seen = new Map();
  for (const row of headings) {
    if (!row.title) continue;
    const count = (seen.get(row.title) || 0) + 1;
    seen.set(row.title, count);
    if (count === 2) issues.push(issue('DUPLICATE_HEADING', 'warn', `같은 제목의 섹션이 반복됩니다: ${row.title}`, 'headings'));
  }
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i].level - headings[i - 1].level > 1) {
      issues.push(issue('HEADING_LEVEL_JUMP', 'warn', `H${headings[i - 1].level} 다음에 H${headings[i].level}로 건너뜁니다.`, 'headings'));
      break;
    }
  }

  const bodyText = stripTags(html);
  if (bodyText.length < 120) issues.push(issue('ARTICLE_BODY_THIN_REVIEW', 'warn', '본문 길이가 짧습니다. 검색의도에 충분한지는 Critic 결과와 함께 확인합니다.', 'html'));

  const blocked = issues.some((item) => item.severity === 'block');
  const warned = issues.some((item) => item.severity === 'warn');
  return {
    version: 'smileseon-deterministic-qa.v1',
    status: blocked ? 'BLOCK' : warned ? 'WARN' : 'PASS',
    issues,
    checks: {
      contract: !issues.some((item) => item.code.startsWith('ARTICLE_') && item.code.endsWith('_REQUIRED')),
      residue: !issues.some((item) => item.severity === 'block' && ['content', 'html'].includes(item.location)),
      bodyLength: bodyText.length,
      headingCount: headings.length,
      sourceCount: Array.isArray(article.sources) ? article.sources.length : 0
    }
  };
}

export function deterministicQaAllowsPublish(result) {
  return Boolean(result) && result.status !== 'BLOCK';
}
