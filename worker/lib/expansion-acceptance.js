// Expanding an article to reach its length floor is where padding and invented sources come from,
// so neither is left to the prompt. Every block a repair wants to insert is checked here, and a
// block that fails is simply not inserted -- the rest still land, and nothing already in the
// article is ever touched, because the caller rebuilds from the original parts.
//
// Three rules, in the order they catch things:
//   1. Redundancy. A block that mostly repeats text already in the article is padding.
//   2. Information gain. A block that introduces no term the article does not already use is
//      padding wearing different words.
//   3. Attribution. A block may not bring in an external link whose host the article does not
//      already cite, and may not name a source in citation shape without linking it. This cannot
//      verify that a fact is true; it stops the failure actually observed on smileinfo.net, which
//      is citation-shaped prose naming documents that do not resolve to anything.

const MAX_INSERTED_BLOCKS = 12;
const REDUNDANCY_LIMIT = 0.62;
const MIN_NEW_TERMS = 3;
const MIN_BLOCK_CHARS = 40;
const SHINGLE = 12;

// Phrases that look like a citation but name no locatable document.
const CITATION_SHAPE_RE = /\b(?:according to|per|based on|as reported by|cited in|guidelines?|standards?|reference manuals?|editorial archive)\b/i;
const STOPWORDS = new Set([
  'the','and','for','that','this','with','from','your','you','are','was','were','have','has','had',
  'not','but','can','will','would','should','could','may','might','into','than','then','them','they',
  'its','it','a','an','of','to','in','on','at','by','or','is','be','as','if','so','do','does','did',
  'when','what','which','who','how','why','more','most','some','any','all','each','one','two'
]);

function textOf(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function shingleSet(text) {
  const n = normalize(text);
  const set = new Set();
  for (let i = 0; i + SHINGLE <= n.length; i += 1) set.add(n.slice(i, i + SHINGLE));
  return set;
}

// How much of the new block is already present in the article.
function containmentIn(blockShingles, bodyShingles) {
  if (blockShingles.size === 0) return 1;
  let shared = 0;
  for (const s of blockShingles) if (bodyShingles.has(s)) shared += 1;
  return shared / blockShingles.size;
}

function contentTerms(text) {
  const terms = new Set();
  for (const match of String(text || '').toLowerCase().matchAll(/[a-z가-힣][a-z가-힣0-9-]{2,}/g)) {
    const term = match[0];
    if (!STOPWORDS.has(term)) terms.add(term);
  }
  for (const match of String(text || '').matchAll(/\d[\d.,]*\s*(?:%|amp|amps|volts?|v|years?|inches|in|mm|cm)?/gi)) {
    terms.add(match[0].trim().toLowerCase());
  }
  return terms;
}

function hostsOf(values) {
  const hosts = new Set();
  for (const value of values) {
    for (const match of String(value || '').matchAll(/https?:\/\/([^/"'\s)]+)/gi)) {
      hosts.add(match[1].replace(/^www\./i, '').toLowerCase());
    }
  }
  return hosts;
}

// A heading for a new section is short by nature and carries few terms, so the length and
// information-gain rules would always reject it and leave its paragraphs orphaned. Headings are
// judged on redundancy and attribution only, and a heading on its own is refused separately --
// see acceptInsertions, which requires real prose to come with it.
function isHeading(raw) {
  return /^\s*<h[23]\b/i.test(String(raw || ''));
}

export function judgeInsertedBlock(raw, context) {
  const text = textOf(raw);
  const heading = isHeading(raw);
  if (!text) return { accepted: false, reason: 'EMPTY_BLOCK' };
  if (!heading && text.length < MIN_BLOCK_CHARS) {
    return { accepted: false, reason: 'TOO_SHORT_TO_ADD_ANYTHING' };
  }

  const redundancy = containmentIn(shingleSet(text), context.bodyShingles);
  if (redundancy >= REDUNDANCY_LIMIT) {
    return { accepted: false, reason: 'REPEATS_EXISTING_TEXT', redundancy: Number(redundancy.toFixed(2)) };
  }

  let newTerms = 0;
  for (const term of contentTerms(text)) if (!context.bodyTerms.has(term)) newTerms += 1;
  if (!heading && newTerms < MIN_NEW_TERMS) {
    return { accepted: false, reason: 'NO_INFORMATION_GAIN', newTerms };
  }

  for (const host of hostsOf([raw])) {
    if (!context.allowedHosts.has(host)) return { accepted: false, reason: 'UNCITED_EXTERNAL_SOURCE', host };
  }
  // Citation-shaped prose with nothing to click is how unverifiable "Standard ... Guidelines"
  // entries got onto this site in the first place.
  if (CITATION_SHAPE_RE.test(text) && !/<a\b[^>]*href\s*=\s*["']https?:/i.test(raw)) {
    return { accepted: false, reason: 'UNLINKED_CITATION_SHAPE' };
  }
  return { accepted: true, redundancy: Number(redundancy.toFixed(2)), newTerms };
}

// insertions: Map<anchorIndex, string[]> as appendOnlyInsertions builds it.
export function acceptInsertions(originalHtml, insertions, options = {}) {
  const bodyText = textOf(originalHtml);
  const context = {
    bodyShingles: shingleSet(bodyText),
    bodyTerms: contentTerms(bodyText),
    allowedHosts: hostsOf([originalHtml, ...(Array.isArray(options.sources) ? options.sources.map((s) => (typeof s === 'string' ? s : s?.url)) : [])])
  };

  const accepted = new Map();
  const rejected = [];
  let kept = 0;
  let keptProse = 0;
  for (const [anchor, blocks] of insertions) {
    const keep = [];
    for (const raw of blocks) {
      if (kept >= MAX_INSERTED_BLOCKS) { rejected.push({ reason: 'TOO_MANY_INSERTED_BLOCKS' }); continue; }
      const verdict = judgeInsertedBlock(raw, context);
      if (!verdict.accepted) { rejected.push({ anchor, ...verdict }); continue; }
      keep.push(raw);
      kept += 1;
      if (!isHeading(raw)) keptProse += 1;
    }
    if (keep.length > 0) accepted.set(anchor, keep);
  }
  // Headings alone are not an expansion; they are a longer table of contents.
  if (keptProse === 0) {
    return { accepted: new Map(), rejected: [...rejected, { reason: 'HEADINGS_WITHOUT_CONTENT' }], keptBlocks: 0 };
  }
  return { accepted, rejected, keptBlocks: kept };
}
