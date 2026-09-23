// The writer is told to "estimate your draft's visible word count" and the critic is told to
// "Estimate the Article's total word count from Article.html's visible text". Both are language
// models estimating their own output, and neither can do it: the editorial band asks for
// 1,500-2,500 words and smileinfo.net's 33 published posts come in at a median of 873, with the
// shortest at 444. Nothing in the system ever counted, so nothing ever caught it.
//
// This counts. The number is handed to the writer as a target before it writes and to the critic
// as a measurement before it judges, so neither is guessing at the one quantity that is trivial
// to compute exactly.

export function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Characters are the unit here, not words. A word count is ambiguous in Korean -- 어절, 단어 and
// whitespace tokens all give different answers -- and it is the ambiguity the model hides its
// under-delivery in. Characters of visible text are one number with one meaning in both
// languages.
export function measureArticleLength(article) {
  const text = visibleText(article?.html);
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
  return {
    chars: text.length,
    hangulChars: hangul,
    latinWords,
    // Reported so a prompt can quote a familiar number, never used as the gate.
    approxWords: hangul > text.length * 0.15 ? Math.round(hangul / 2) + latinWords : latinWords
  };
}

// Derived from what these blogs actually published before the current pipeline, not invented:
// the Korean floor is the median of PC 라이프 세이버's pre-August posts (5,468 characters) pulled
// down to a floor, and the English target is the character equivalent of the 1,500-2,500 word
// band the editorial guide already asks for. Deep-dive keeps its existing multiple.
const BANDS = Object.freeze({
  ko: { floorChars: 3800, targetChars: 5500 },
  en: { floorChars: 8000, targetChars: 11000 }
});
const DEEP_DIVE_MULTIPLIER = 1.6;

export function lengthContract(language, recommendedDepth = 'standard-explainer') {
  const band = BANDS[String(language || '').trim()] || BANDS.ko;
  const deep = String(recommendedDepth || '') === 'deep-dive';
  const scale = deep ? DEEP_DIVE_MULTIPLIER : 1;
  return {
    unit: 'characters of visible text, excluding HTML tags',
    floorChars: Math.round(band.floorChars * scale),
    targetChars: Math.round(band.targetChars * scale),
    depth: deep ? 'deep-dive' : 'standard-explainer',
    note: 'A floor is evidence of coverage, not a quota. Reaching it by repeating or padding is a worse failure than falling short.'
  };
}

export function lengthVerdict(article, language, recommendedDepth) {
  const measured = measureArticleLength(article);
  const contract = lengthContract(language, recommendedDepth);
  return {
    ...measured,
    floorChars: contract.floorChars,
    targetChars: contract.targetChars,
    belowFloor: measured.chars < contract.floorChars,
    shortfallChars: Math.max(0, contract.floorChars - measured.chars)
  };
}
