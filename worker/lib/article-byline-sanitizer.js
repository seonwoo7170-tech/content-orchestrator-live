// Every smileinfo.net post that prints its own publication date in the body is printing a date
// the writer invented. 14 of the 33 published posts carry one and 12 of those contradict the
// real publish date: a post published 2026-09-10 says "March 2026", one published 2026-09-21
// says "September 11, 2026", and one published 2026-09-05 has "Standard Guide" sitting where
// the date should be. Blogger already renders the real date from the post record, so the page
// shows two dates that disagree -- which reads as an unmaintained page, and Google names
// restamping a date without changing the content as a search-first signal.
//
// The writer is asked not to emit one, but a prompt is a request and this is a defect with one
// correct answer, so the date is removed here as well. Only the invented line goes: the byline
// beside it is left exactly as the writer wrote it, because who is credited is an editorial
// decision and not this module's business.
//
// Matching is confined to leaf blocks -- a <div> or <p> whose content opens no further block --
// so the wrapper <div class="article-container"> around the whole article can never match, and
// a <li> inside a Sources list can carry "Published: 2024" as part of a citation untouched.
const LEAF_BLOCK_RE = /<(div|p)\b[^>]*>((?:(?!<(?:div|p|section|article|ul|ol|table|blockquote|h[1-6])\b)[\s\S])*?)<\/\1>/gi;
const DATE_LINE_RE = /(?:<br\s*\/?>\s*)?(?:Published|Last\s+updated|Updated|Reviewed|게시일|작성일|최종\s*수정)\s*:[^<]*/gi;
const METADATA_TEXT_LIMIT = 160;

function textOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripInBodyPublicationDate(article) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const html = String(article.html || '');
  if (!html) return article;

  const blocks = new RegExp(LEAF_BLOCK_RE.source, LEAF_BLOCK_RE.flags);
  const cleaned = html.replace(blocks, (whole, tag, inner) => {
    const text = textOf(inner);
    // Long enough to be prose is long enough to leave alone.
    if (!text || text.length > METADATA_TEXT_LIMIT) return whole;
    const dates = new RegExp(DATE_LINE_RE.source, DATE_LINE_RE.flags);
    if (!dates.test(inner)) return whole;

    const strippedInner = inner.replace(new RegExp(DATE_LINE_RE.source, DATE_LINE_RE.flags), '');
    // Nothing but the invented date was in there, so the block itself goes.
    if (!textOf(strippedInner)) return '';
    return whole.replace(inner, strippedInner);
  });

  if (cleaned === html) return article;
  return { ...article, html: cleaned.replace(/\n{3,}/g, '\n\n') };
}
