// Master v4.5 section 62 requires the byline block at the top of every article:
//
//   <div style="margin-bottom:20px;"><strong>Editorial Team</strong><br>Published: [DATE]</div>
//
// and section 55 requires "Last updated: [DATE]" in the closing block. The writer emits both, as
// instructed. What it cannot do is resolve [DATE]: it does not know when the post will be
// published, because publication is scheduled later by the auto-publisher. So it invents one, and
// 12 of the 14 smileinfo.net posts carrying a date contradict their real publication date -- one
// published 2026-09-10 reads "March 2026", one published 2026-09-05 has "Standard Guide" sitting
// where the date should be. Blogger renders the real date from the post record beside it, so the
// page shows two dates that disagree.
//
// The block stays, because the spec requires it. The value is filled here instead, at publication,
// from the date actually being used. Whatever the writer guessed is overwritten. When there is no
// date to supply -- an update to an existing post, whose original publication date this side does
// not hold -- the line is removed rather than guessed at, and a block left with nothing but the
// date goes with it.
const LEAF_BLOCK_RE = /<(div|p)\b[^>]*>((?:(?!<(?:div|p|section|article|ul|ol|table|blockquote|h[1-6])\b)[\s\S])*?)<\/\1>/gi;
// The label is captured, not assumed: a Korean article writes 게시일 and must keep it.
const PUBLISHED_RE = /(<br\s*\/?>)?\s*(Published|게시일|작성일)\s*:[^<]*/gi;
const UPDATED_RE = /(<br\s*\/?>)?\s*(Last\s+updated|Updated|Reviewed|최종\s*수정)\s*:[^<]*/gi;
const METADATA_TEXT_LIMIT = 200;

function textOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatPublicationDate(value, language = 'en') {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return null;
  if (String(language || '').trim() === 'ko') {
    return `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일`;
  }
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function rewriteSegment(inner, pattern, formatted) {
  const probe = new RegExp(pattern.source, pattern.flags);
  if (!probe.test(inner)) return inner;
  const replacer = new RegExp(pattern.source, pattern.flags);
  let first = true;
  return inner.replace(replacer, (match, lineBreak, label) => {
    // No date to supply, or a duplicate line: the segment goes rather than carrying a guess.
    if (!formatted || !first) return '';
    first = false;
    return `${lineBreak || ''}${label}: ${formatted}`;
  });
}

export function applyPublicationDate(article, options = {}) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const html = String(article.html || '');
  if (!html) return article;

  const language = options.language ?? article.language ?? 'en';
  const published = formatPublicationDate(options.publishedAt, language);
  const updated = formatPublicationDate(options.updatedAt, language);

  const blocks = new RegExp(LEAF_BLOCK_RE.source, LEAF_BLOCK_RE.flags);
  const next = html.replace(blocks, (whole, tag, inner) => {
    const text = textOf(inner);
    // Long enough to be prose is long enough to leave alone.
    if (!text || text.length > METADATA_TEXT_LIMIT) return whole;

    let rewritten = inner;
    rewritten = rewriteSegment(rewritten, PUBLISHED_RE, published);
    rewritten = rewriteSegment(rewritten, UPDATED_RE, updated);
    if (rewritten === inner) return whole;
    // The block held nothing but a date this side could not supply.
    if (!textOf(rewritten)) return '';
    return whole.replace(inner, rewritten);
  });

  if (next === html) return article;
  return { ...article, html: next.replace(/\n{3,}/g, '\n\n') };
}
