function stripImageFigures(html) {
  return String(html || '')
    .replace(/<figure\b[^>]*>[\s\S]*?<img\b[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, '');
}

export function stripWriterOwnedImages(article) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const html = String(article.html || '');
  if (!html) return article;
  const stripped = stripImageFigures(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped === html) return article;
  return { ...article, html: stripped };
}

// A <ul> inside a <p> is invalid HTML that every browser silently repairs by closing the
// paragraph first, and it is why job 216 -- a 92-score article with one finding -- could not
// be published. The critic reported INVALID_HTML_NESTING, repair did the only thing that fixes
// it and moved the list out, and the targeted-repair guard rejected the result because the
// block count went 44 -> 47: the guard counts <p> and <li> as blocks, and lifting a three-item
// list out of a paragraph necessarily creates three of them. Every attempt failed the same way.
//
// Repair cannot win that argument, and it should never have been asked to. Invalid nesting is
// a defect with one correct answer, so it is fixed here, before the critic ever sees the
// article. The block count is then stable from the first critic pass onward.
const PARAGRAPH_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
const NESTED_BLOCK_RE = /<(ul|ol|table|blockquote|h2|h3|h4|figure|pre)\b[^>]*>[\s\S]*?<\/\1>/gi;

function hasText(value) {
  return Boolean(String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim());
}

function liftParagraph(inner) {
  const blocks = new RegExp(NESTED_BLOCK_RE.source, NESTED_BLOCK_RE.flags);
  const parts = [];
  let cursor = 0;
  let match;

  while ((match = blocks.exec(inner))) {
    const before = inner.slice(cursor, match.index);
    if (hasText(before)) parts.push(`<p>${before.trim()}</p>`);
    parts.push(match[0]);
    cursor = blocks.lastIndex;
  }
  if (!parts.length) return null;

  const after = inner.slice(cursor);
  if (hasText(after)) parts.push(`<p>${after.trim()}</p>`);
  return parts.join('');
}

export function liftBlocksOutOfParagraphs(article) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const html = String(article.html || '');
  if (!html) return article;

  const paragraphs = new RegExp(PARAGRAPH_RE.source, PARAGRAPH_RE.flags);
  const lifted = html.replace(paragraphs, (whole, inner) => liftParagraph(inner) ?? whole);
  return lifted === html ? article : { ...article, html: lifted };
}
