function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedLinks(links = []) {
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(links) ? links : []) {
    const url = canonicalHttpUrl(item?.url || item?.targetUrl || item?.target_url);
    const label = String(item?.query || item?.anchorText || item?.anchor_text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!url || !label || seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, label });
    if (rows.length >= 3) break;
  }
  return rows;
}

export function applyInternalLinksToArticle(article, links = []) {
  if (!article || typeof article !== 'object') throw new Error('ARTICLE_REQUIRED');
  const html = String(article.html || '');
  if (!html || html.includes('data-smileseon-internal-links="1"')) {
    return { article, appliedCount: 0, alreadyApplied: html.includes('data-smileseon-internal-links="1"') };
  }
  const rows = normalizedLinks(links);
  if (!rows.length) return { article, appliedCount: 0, alreadyApplied: false };

  const korean = String(article.language || '').toLowerCase() === 'ko' || /[가-힣]/.test(`${article.title || ''} ${html}`);
  const lead = korean ? '함께 읽으면 좋은 글' : 'Related guides';
  const anchors = rows
    .map((row) => `<a href="${escapeHtml(row.url)}" rel="noopener">${escapeHtml(row.label)}</a>`)
    .join(' · ');
  const block = `<p data-smileseon-internal-links="1"><strong>${lead}</strong><br>${anchors}</p>`;
  const nextHtml = /<\/article>\s*$/i.test(html)
    ? html.replace(/<\/article>\s*$/i, `${block}</article>`)
    : `${html}\n${block}`;

  return {
    article: { ...article, html: nextHtml },
    appliedCount: rows.length,
    alreadyApplied: false
  };
}
