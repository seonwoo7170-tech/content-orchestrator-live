// src/lib/article-length.js
function visibleText(html) {
  return String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}
__name(visibleText, "visibleText");
function measureArticleLength(article) {
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
__name(measureArticleLength, "measureArticleLength");
var BANDS = Object.freeze({
  ko: { floorChars: 3800, targetChars: 5500 },
  en: { floorChars: 8e3, targetChars: 11e3 }
});
var DEEP_DIVE_MULTIPLIER = 1.6;
function lengthContract(language, recommendedDepth = "standard-explainer") {
  const band = BANDS[String(language || "").trim()] || BANDS.ko;
  const deep = String(recommendedDepth || "") === "deep-dive";
  const scale = deep ? DEEP_DIVE_MULTIPLIER : 1;
  return {
    unit: "characters of visible text, excluding HTML tags",
    floorChars: Math.round(band.floorChars * scale),
    targetChars: Math.round(band.targetChars * scale),
    depth: deep ? "deep-dive" : "standard-explainer",
    note: "A floor is evidence of coverage, not a quota. Reaching it by repeating or padding is a worse failure than falling short."
  };
}
__name(lengthContract, "lengthContract");
function lengthVerdict(article, language, recommendedDepth) {
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
__name(lengthVerdict, "lengthVerdict");
