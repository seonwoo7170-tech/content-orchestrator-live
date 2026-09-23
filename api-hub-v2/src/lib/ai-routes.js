import { runWorkersAi } from './cloudflare-ai.js';
import { runGeminiAi } from './gemini-ai.js';
import { runPrimaryWithGeminiFallback } from './ai-provider-router.js';
import { MASTER_V45, parseJsonText } from './contracts.js';
import { loadMasterV45RolePrompt } from './master-v45-role-prompts.js';
import { collectWriterResearch } from './tavily-search.js';
import { buildTourApiResearch, getAttractionDetail } from './tour-api.js';
import { freeAiConfigured, freeAiFallbackEnabled, freeAiModel, runFreeAi, shouldFallbackFromFreeAi } from './free-ai.js';
import { lengthContract, lengthVerdict } from './article-length.js';

const WRITER_ADAPTER = `AUTOMATION WRITER ADAPTER — this adapter overrides any interactive/questioning flow in the master prompt for this server call.
Platform is Google Blogger / Blogspot. Do not ask questions. Do not wait for user selection. Produce one complete publication-ready Article from the supplied topic and language.
Return JSON only with this exact top-level shape: {"article":{"title":"...","html":"...","searchDescription":"...","labels":["..."],"sources":[...],"language":"ko|en","topic":"...","thumbnailHook":"..."}}.
thumbnailHook is a short overlay caption rendered on top of the thumbnail image, separate from the title. It must be a short, concrete phrase in the article's language, clearly different from the title and from the topic string, not a restatement, truncation, or light rewording of either. Name the specific thing the reader gets, in the plainest words that still fit. Two things are forbidden outright. First, hype: never use “unlock”, “secret”, “insider”, “ultimate”, “guaranteed”, 은밀한 비법, 최강, 완벽, 꿀팁 or any equivalent superlative, and no exclamation marks. Second, unsupported specifics: a figure may appear only when that exact figure is stated in the article body, so “Unlock 30% Energy Savings!” on an article that never measured 30%, or “발열 10도 낮추는 비법” on an article that never measured 10 degrees, is a fabricated claim printed on an image and is not acceptable. The server rejects a caption that breaks either rule and falls back to a section heading, so a plain honest phrase is always better than a rejected clever one. Keep it glanceable: at most 22 characters for Korean, at most 38 characters for other languages, no ellipsis, quotation marks, or trailing punctuation.
INTERNAL LINKS — internalLinkCandidates, when supplied, lists posts already published on this same blog, each with its real title and its real URL. Master v4.5 forbids inventing an internal URL and has you leave an HTML comment when you do not know one; these are the URLs, so use them and do not leave the comment in their place. Place two to four of them inside the body where a reader genuinely benefits, as ordinary <a href="..."> links with descriptive anchor text drawn from the sentence around them, never a bare "click here" and never a row of links bolted onto the end. Link only where the candidate is actually relevant to what the sentence is saying: three well-placed links are worth more than eight forced ones, and a candidate that fits nowhere should simply not be used. Use each URL at most once, exactly as given, and never modify it. Where no candidate is supplied or none is relevant, the Master v4.5 comment placeholder remains correct.
PUBLICATION METADATA — write the byline and closing blocks exactly as Master v4.5 requires, but leave every date in them as the literal token [DATE]. You do not know when this post will be published: publication is scheduled by the server well after you finish drafting, and the server substitutes the real date into those blocks before publishing. A date you write there is a guess and it will be wrong -- 12 of 14 published articles that carried one contradicted their own publication date, one of them by six months, and Blogger renders the true date beside it, so the page showed two dates that disagreed. Never write an actual month, day or year after Published:, Last updated:, Updated:, 게시일: or 작성일:. A date belongs in the body only when it is part of the subject matter -- the effective date of a regulation, the model year of a product, the date a cited document was issued.
The html field must contain only the Blogger post body, not <html>, <head>, or <body>. The title field is the Blogger post title and the Blogger theme/page template supplies the page-level heading; do not duplicate the title as an <h1> inside html. For language=en, write a natural search-oriented English title and do not default to "How to". Use "How to" only when the reader is genuinely looking for a procedural or step-by-step task. For explanation, diagnosis, comparison, selection, timing, cost, suitability, definition, or troubleshooting intent, choose the most natural title form for the query, including Why, What, Which, When, Can, Should, Is/Are, Does/Do, How Much, How Long, How Often, or a concise non-question title. Avoid formulaic repetition and preserve the supplied topic/search intent rather than forcing an awkward question word. Use <h2> for the first body section heading when a heading is needed. Do not use placeholders, invented URLs, invented quotations, invented first-hand experience, or unsupported current claims. Keep prose practical, answer-first, skimmable, and less academic/manual-like. If current facts cannot be verified from the supplied context, avoid asserting them as current facts. SearchDescription must be concise plain text. labels and sources must always be arrays.
CONTENT COMPLETENESS GATE — before producing the final JSON, silently identify the reader's primary decision or action and the essential subquestions that must be answered for that reader to act confidently. A valid structure is not enough. Cover every applicable core dimension with concrete, non-redundant substance: the direct answer or recommendation; why it works or what causes the problem when relevant; decision criteria and meaningful trade-offs; practical steps in the order they should be done; prerequisites, materials, cost/time factors or setup requirements when relevant; safety limits, exceptions and cases where the advice should not be used; common failure modes or mistakes; and at least one concrete example, checkpoint, or decision rule when it materially improves understanding. Omit only dimensions that are genuinely irrelevant to the topic. Do not pad to reach a word count. Use the available output budget for information gain, examples, boundaries and actionable detail rather than filler. Never omit a core answer merely to keep the article short. If a necessary current fact cannot be supported, state the limitation or use stable guidance instead of inventing it.
When a research object is supplied, treat it as the only web research performed for this request. Ground time-sensitive/current claims in those records, prefer primary or official sources when present, and never invent a source beyond the supplied research URLs. The Article.sources field must contain only sources actually used. When research was requested but unavailable, do not present unverifiable information as current fact; reframe the article around stable guidance or explicitly bounded information.
SOURCE ATTRIBUTION — name an external organisation, publication, standard, statute, or study, or state an attributed statistic, only when a supplied research record actually supports it. Where no supplied record supports it, write the guidance without the attribution or leave the claim out. Never reach for a plausible-sounding authority, a remembered study, a regulator whose remit does not cover the topic, or a wiki to make a sentence look sourced: naming a source that was not supplied is a fabrication even when the underlying fact happens to be true.
When seoBrief is supplied, use it as planning and search-intent context: follow its searchIntent, intentGoal, answerFirst, information-gain, freshness, internal-link and cannibalization guidance where applicable. SEO brief metrics are evidence for planning, not article facts to quote or invent. Never force keyword density or unsupported claims merely to satisfy the brief.
DEPTH EXPECTATION — lengthContract gives you the length this article is planned for, already counted for you in characters of visible text with HTML tags excluded. It is not a word estimate and you must not re-estimate it: floorChars is the minimum the finished body must reach and targetChars is where it should land. The same count is measured in code after you return and again when the article is reviewed, so a draft below floorChars is short as a matter of fact, not opinion. Treat that as a coverage test rather than a quota: a body below the floor means you skipped or compressed dimensions the CONTENT COMPLETENESS GATE requires, so go back and add the missing decision criteria, trade-offs, concrete examples and numbers, failure modes, exceptions and the cases where the advice does not apply. Never pad, repeat or restate to reach it -- reaching the floor with filler is a worse failure than falling short, and is treated as one. Korean runs roughly 2.4 characters per 어절 and English roughly 6.3 per word, if you want a familiar check on your own draft.
When rewriteExisting is true, this is an in-place modernization of an existing Blogger post, not a patch and not a new post. Use rewriteSource only to preserve the same core subject, primary search intent, language, and important title terms. Rewrite the entire body from scratch under the current Master v4.5 and CONTENT COMPLETENESS GATE instead of imitating or lightly editing the old prose. The title may be improved modestly for clarity, natural wording, and search intent, but must remain recognizably about the same subject; do not pivot to a different angle merely to make it sound new. Do not copy old boilerplate. Do not output, alter, or invent Blogger identity fields, URLs, or post IDs; the caller preserves the existing post identity and will update that same post.
If candidateAttempt is greater than 1, this is a last-resort fresh candidate after targeted repairs were exhausted. Preserve the same topic and search intent, but produce a genuinely fresh candidate instead of echoing the failed wording. Use retryReason only as a failure signal to avoid repeating the same defect; do not mention retry mechanics in the article.`;

const CRITIC_SYSTEM = `You are a strict publication critic. Return JSON only. Evaluate factual reliability, source quality, search-intent fit, practical usefulness, substantive completeness (including whether the article's length is adequate for its content type), readability, platform-safe HTML, and whether the prose is overly academic or manual-like. Schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable article field or html block","reason":"specific reason","repairInstruction":"specific minimal repair"}]}. PASS requires zero issues. FAIL requires at least one issue. Do not invent facts or sources.`;

const CRITIC_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 COMPLIANCE CRITIC ADAPTER — this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding full integrated Master v4.5 as the governing publication requirements and reference checklist. This route selects the Critic role and overrides any conflicting Writer, platform-selection, questioning, or interactive execution flow from the integrated Master. Do NOT execute a writer workflow. Audit the supplied Article against every applicable publication-quality requirement in the integrated Master, not merely broad writing quality.

This server call is specifically for Google Blogger / Blogspot. The Article.title field is the Blogger post title and is rendered by the Blogger page/theme outside Article.html. Therefore absence of an <h1> element inside Article.html is NOT a defect and must never be reported as MISSING_H1_IN_HTML or an equivalent issue. A duplicate title <h1> inside the Blogger body is not required. Treat <h2> as the normal first section-heading level in Article.html.

Perform a strict compliance pass across all applicable areas, including article purpose and search intent, answer-first usefulness, factual reliability and unsupported claims, source/citation integrity, title and description quality, heading/section logic, readability and sentence density, repetition and filler, AI-like or overly academic/manual-like prose, practical usefulness, substantive completeness, tables/lists where appropriate, Blogger-safe HTML, labels, language consistency, prohibited fabrication, and every other applicable publication rule stated in the integrated Master v4.5.

CONTENT COMPLETENESS PASS — independently derive the reader's primary decision/action and the essential subquestions implied by the Article.title, topic, and seoBrief when supplied. Do not PASS an article merely because its headings and structure look complete. Verify that the body actually supplies enough concrete information for a reader to act or decide: the direct answer; applicable reasoning or cause; decision criteria/trade-offs; executable steps; relevant prerequisites/cost/time/material considerations; exceptions/safety/boundaries; common failure modes; and concrete examples/checkpoints where they materially improve the answer. Only require dimensions that are genuinely relevant to the topic. If a materially necessary core answer is missing or too vague to support action, emit code CORE_INFORMATION_MISSING. Point that issue to the single existing machine-targetable HTML block that should be expanded or replaced to supply the missing information, preferably the nearest relevant paragraph or heading block. Never use "article body" or another coarse location. The repair instruction must name the missing decision/action information, not ask for generic length or filler.

ARTICLE LENGTH PASS — measuredLength is supplied with the Article and was counted in code, not estimated: chars is the visible text with HTML tags excluded, floorChars is the minimum this article was planned for, and belowFloor and shortfallChars state whether and by how much it falls short. Do not estimate the length yourself and do not dispute these numbers; they are measurements. When belowFloor is false the article has the planned depth and length is not a finding -- say nothing about it. When belowFloor is true the article is missing content, because the floor is set at the length the necessary coverage takes: identify which specific core decision or action dimension is thin or missing as a result and emit CORE_INFORMATION_MISSING against the block or blocks that should be expanded with concrete additional substance, naming what to add. Never emit a length finding on its own with no missing-content reason, and never instruct padding, filler or restatement to reach a number -- an article that reaches the floor by repeating itself has a worse defect than a short one, and that is the finding to emit instead.

When seoBrief is supplied, also audit the Article against applicable brief constraints such as search intent, answer-first usefulness, information gain, freshness/source requirements, internal-link intent and cannibalization avoidance. Treat brief metrics as planning evidence only, never as facts the Article was required to repeat. Do not invent a violation when the brief requirement is not applicable to the specific Article.

Run the audit as separate passes and do not collapse materially different violations into one issue. A distinct repair action must receive a distinct issue. Independently inspect at minimum: (1) title exaggeration, clickbait, guarantees, or unsupported certainty; (2) unsupported absolute claims in the body; (3) fabricated or unsupported statistics; (4) fabricated, placeholder, invalid, or unverifiable source names and URLs visible in the Article; (5) unsafe, destructive, or operationally risky instructions; (6) repetition and filler; (7) malformed or unsafe HTML; (8) misleading or overclaiming searchDescription; (9) substantive completeness and missing core decision/action information; (10) article length relative to the applicable Master v4.5 Section 26 band, reported only as CORE_INFORMATION_MISSING per the ARTICLE LENGTH PASS above, never as a standalone length defect; and (11) every other applicable Master v4.5 violation. Consolidate only exact duplicates of the same defect.

Do not reward fluent prose by assuming compliance. Actively look for concrete violations. Do not invent violations, facts, sources, or external verification. If a rule is genuinely not applicable, do not penalize it. If external verification is unavailable, never pretend that you browsed the web; judge whether the Article itself provides adequate support and whether claims are framed safely.

LOCATION CONTRACT — every issue.location must be machine-targetable. For Article.html, enumerate the supported top-level blocks <p>, <h2>, <h3>, <li>, and <blockquote> in one shared document-order sequence starting at 1, then use exactly: "html p N", "html h2 N", "html h3 N", "html li N", or "html blockquote N". N is the shared document-order block number, not a per-tag counter. For non-HTML fields use exactly one of: "title", "searchDescription", "labels", "sources", "language", or "topic". Never use only a heading title, prose fragment, "introduction", "conclusion", "section-1", "body", or another human-only location. If two different HTML blocks need changes, emit separate issues with their exact locations.

Return JSON only using exactly this schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable location from the LOCATION CONTRACT","reason":"specific Master v4.5 compliance reason","repairInstruction":"specific minimal repair that preserves unaffected content"}]}.

PASS is allowed only when score is at least 95 AND issues is empty. Any concrete issue means FAIL, even if the numeric score is 95 or higher. FAIL must contain at least one issue. Each issue must identify a precise location and an actionable minimal repair. Return all concrete issues you can support from the supplied Article itself.`;

const REPAIR_SYSTEM = `You are a targeted repair editor. Return JSON only. Repair ONLY the exact locations identified by critic issues. Treat each issue.location as a hard edit boundary. Preserve unaffected content byte-for-byte whenever possible, preserve original meaning, Blogger identity fields, language, title unless explicitly flagged, thumbnailHook, and all verified sources. Never fabricate experience, facts, statistics, URLs, or citations. Return the complete repaired Article object.`;

const REPAIR_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 TARGETED REPAIR ADAPTER — this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding full integrated Master v4.5 as governing publication constraints. This route selects the targeted Repair role and overrides any conflicting Writer, platform-selection, questioning, or interactive execution flow from the integrated Master. Apply every supplied critic issue, but change only the smallest affected sections necessary. Do not rewrite clean sections merely for style preference. A repair must not introduce a new Master v4.5 violation elsewhere.
The supplied issue.location values are hard edit boundaries. For HTML locations such as "html p 3" or "html h2 5", change only those exact document-order blocks. Do not reformat, reorder, normalize whitespace, change tags, or rewrite any unflagged HTML block. For field locations such as "title" or "searchDescription", change only that field. Return all unflagged Article fields and all unflagged HTML exactly as received.
For CORE_INFORMATION_MISSING, use the flagged block to add the specific missing decision rule, step, boundary, trade-off, prerequisite, or example named by the issue. Add concrete useful information, not generic filler or a longer restatement. Stay within the hard edit boundary and use only supplied/verified facts or stable guidance; if the missing fact cannot be supported, state the limitation rather than inventing it.
When seoBrief is supplied, preserve its applicable search-intent and information-gain goals while making only the flagged repair. Do not use the brief as permission to change unflagged sections or to invent unsupported facts.
This is Google Blogger / Blogspot: Article.title is rendered outside Article.html, so do not add a duplicate <h1> to the body merely because the body has no <h1>.
Return the complete repaired Article object as JSON only. Either a direct Article object or {"article": Article} is accepted by the server, but do not add prose outside JSON. Preserve title, topic, language, labels, sources, searchDescription, thumbnailHook, and unaffected HTML unless an issue specifically requires changing them. Never fabricate first-hand experience, facts, statistics, quotations, URLs, sources, or current claims.`;

const OUTPUT_TOKEN_BUDGET = Object.freeze({
  diagnostic: 256,
  writer: 12288,
  critic: 12288,
  repair: 12288
});

const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const CRITIC_PASS_MIN_SCORE = 95;
const CRITIC_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function validateArticleShape(value, input, prefix) {
  const article = value?.article && typeof value.article === 'object' ? value.article : value;
  if (!article || typeof article !== 'object') throw Object.assign(new Error(`${prefix}_ARTICLE_REQUIRED`), { status: 502 });
  const requiredStrings = ['title', 'html', 'searchDescription', 'language', 'topic'];
  for (const key of requiredStrings) {
    if (typeof article[key] !== 'string' || !article[key].trim()) {
      throw Object.assign(new Error(`${prefix}_ARTICLE_${key.toUpperCase()}_REQUIRED`), { status: 502 });
    }
  }
  if (!Array.isArray(article.labels)) throw Object.assign(new Error(`${prefix}_ARTICLE_LABELS_REQUIRED`), { status: 502 });
  if (!Array.isArray(article.sources)) throw Object.assign(new Error(`${prefix}_ARTICLE_SOURCES_REQUIRED`), { status: 502 });
  const requestedLanguage = String(input?.language || '').trim();
  if (requestedLanguage && article.language !== requestedLanguage) {
    throw Object.assign(new Error(`${prefix}_LANGUAGE_MISMATCH`), { status: 502 });
  }
  return article;
}

function validateWriterArticle(value, input) {
  return validateArticleShape(value, input, 'WRITER');
}

function validateRepairArticle(value, input) {
  return validateArticleShape(value, { language: input?.article?.language }, 'REPAIR');
}

// Targeted repair is asked to return the complete article, and sometimes it returns only the
// parts it touched -- which is the honest reading of "change only the flagged location".
// Validating that raw response as a whole article then killed the job on a missing title:
// REPAIR_ARTICLE_TITLE_REQUIRED held jobs 172 and 206. The complete article is sitting in the
// request, and the worker's targeted-repair guard rebuilds the result from it anyway, so the
// only thing this validation ever achieved was throwing work away. Read what the model
// changed and keep the rest; the guard is still the authority on what is allowed to change.
const REPAIR_TEXT_FIELDS = Object.freeze(['title', 'html', 'searchDescription', 'language', 'topic']);
const REPAIR_ARRAY_FIELDS = Object.freeze(['labels', 'sources']);

function mergeRepairArticle(parsed, input) {
  const returned = parsed?.article && typeof parsed.article === 'object' && !Array.isArray(parsed.article)
    ? parsed.article
    : parsed;
  if (!returned || typeof returned !== 'object' || Array.isArray(returned)) {
    throw Object.assign(new Error('REPAIR_ARTICLE_REQUIRED'), { status: 502 });
  }

  const base = input?.article && typeof input.article === 'object' && !Array.isArray(input.article)
    ? input.article
    : null;
  if (!base) return returned;

  const merged = { ...base, ...returned };
  // A field the model omitted, blanked, or returned in the wrong type is a field it did not
  // repair, so it keeps the value the caller sent.
  for (const field of REPAIR_TEXT_FIELDS) {
    if (typeof merged[field] !== 'string' || !merged[field].trim()) merged[field] = base[field];
  }
  for (const field of REPAIR_ARRAY_FIELDS) {
    if (!Array.isArray(merged[field])) merged[field] = base[field];
  }
  return merged;
}

// The critic is a language model and its output is prose that happens to be JSON. Demanding
// an exact uppercase token from it is a design error, not a contract: a verdict of "pass" or
// " PASS" parsed cleanly and then failed validation, and because both providers are language
// models they tend to make the same formatting choice, which is why the free-ai -> Cloudflare
// fallback could not rescue it. Five jobs -- 214, 215, 217, 223 and 230 -- were held on
// CRITIC_SCHEMA_INVALID by 2026-09-23 with a finished article and a perfectly readable verdict
// attached. Normalising the shape the model chose costs nothing and changes no verdict; what
// the critic actually decided is still the only thing that counts.
const CRITIC_STATUS_ALIASES = new Map([
  ['PASS', 'PASS'], ['PASSED', 'PASS'], ['PASSES', 'PASS'], ['OK', 'PASS'],
  ['FAIL', 'FAIL'], ['FAILED', 'FAIL'], ['FAILS', 'FAIL']
]);

function normalizeCriticStatus(value) {
  return CRITIC_STATUS_ALIASES.get(String(value ?? '').trim().toUpperCase()) || null;
}

function normalizeCriticSeverity(value) {
  const severity = String(value ?? '').trim().toUpperCase();
  return CRITIC_SEVERITIES.has(severity) ? severity : null;
}

function validateCriticIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (typeof issue.code !== 'string' || !issue.code.trim()) return false;
  if (!normalizeCriticSeverity(issue.severity)) return false;
  if (typeof issue.location !== 'string' || !issue.location.trim()) return false;
  if (typeof issue.reason !== 'string' || !issue.reason.trim()) return false;
  if (typeof issue.repairInstruction !== 'string' || !issue.repairInstruction.trim()) return false;
  return true;
}

function normalizeCriticResult(parsed) {
  const status = parsed && typeof parsed === 'object' ? normalizeCriticStatus(parsed.status) : null;
  if (!status) {
    throw Object.assign(new Error('CRITIC_SCHEMA_INVALID'), { status: 502 });
  }

  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw Object.assign(new Error('CRITIC_SCORE_INVALID'), { status: 502 });
  }

  const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
  if (!rawIssues.every(validateCriticIssue)) {
    throw Object.assign(new Error('CRITIC_ISSUE_SCHEMA_INVALID'), { status: 502 });
  }
  const issues = rawIssues.map((issue) => ({ ...issue, severity: normalizeCriticSeverity(issue.severity) }));
  if (status === 'FAIL' && issues.length === 0) {
    throw Object.assign(new Error('CRITIC_FAIL_WITHOUT_ISSUES'), { status: 502 });
  }

  if (issues.length > 0) {
    return {
      ...parsed,
      score,
      status: 'FAIL',
      issues,
      contractNormalized: status === 'PASS' ? 'PASS_WITH_ISSUES_TO_FAIL' : undefined
    };
  }

  if (score < CRITIC_PASS_MIN_SCORE) {
    throw Object.assign(new Error('CRITIC_PASS_SCORE_BELOW_THRESHOLD'), { status: 502 });
  }

  return { ...parsed, score, status: 'PASS', issues };
}

// Malformed-output errors, in the sense of "this provider did not honour the critic
// contract". A different model can legitimately be asked the same question, so these are
// the free-ai -> Cloudflare fallback triggers. CRITIC_PASS_SCORE_BELOW_THRESHOLD is
// deliberately absent: that is a real verdict about the article, and retrying it on a
// second model would just be shopping for a more lenient judge.
const CRITIC_CONTRACT_ERRORS = new Set([
  'AI_PROVIDER_JSON_INVALID',
  'CRITIC_SCHEMA_INVALID',
  'CRITIC_SCORE_INVALID',
  'CRITIC_ISSUE_SCHEMA_INVALID',
  'CRITIC_FAIL_WITHOUT_ISSUES'
]);

function isCriticContractError(error) {
  return CRITIC_CONTRACT_ERRORS.has(String(error?.message || ''));
}

// Dropped 2026-09-22. The writer declared an evidence array and the critic route compared
// each declared URL against Article.sources, but those are different sets: a TourAPI job
// cites apis.data.go.kr in its evidence and lists something else in sources, so jobs 215
// and 220 had every legitimate claim reported as unbacked and burned all four continuations
// on UNSUPPORTED_SOURCE_ATTRIBUTION. 217 emitted the same code five times with no evidence
// at all, and 218 invented MISSING_EVIDENCE_FOR_CLAIM off the new vocabulary -- naming a new
// issue code in the prompt is enough for the critic to reach for it. The writer keeps the
// plain attribution rule, which costs no output tokens and feeds the critic nothing.
function stripEvidence(article) {
  if (!article || typeof article !== 'object' || !('evidence' in article)) return article;
  const { evidence: _dropped, ...rest } = article;
  return rest;
}

function providerMetadata(result) {
  return {
    model: result.model,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed,
    primaryError: result.primaryError,
    usage: result.usage
  };
}

export async function diagnostic(env, aiBinding = env?.AI) {
  const model = env.WRITER_MODEL || '@cf/openai/gpt-oss-120b';
  const result = await runWorkersAi(env, {
    model,
    messages: [{ role: 'user', content: 'Reply only with OK' }],
    maxTokens: OUTPUT_TOKEN_BUDGET.diagnostic
  }, aiBinding);
  return {
    ok: /^ok[.!]?$/i.test(String(result.response || '').trim()),
    model,
    response: String(result.response || '').trim(),
    usage: result.usage
  };
}

export async function writer(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const language = String(input?.language || '').trim();
  if (!['ko', 'en'].includes(language)) throw Object.assign(new Error('WRITER_LANGUAGE_INVALID'), { status: 400 });

  // A TourAPI-sourced job (smileatlas) supplies a real attraction instead of a bare topic
  // string. Fetching it here (not in the caller) keeps this the only place that decides
  // between real official facts and Tavily search, and lets the attraction's own title
  // stand in for topic when the caller did not already supply one.
  const tourApiContentId = String(input?.tourApiContentId || '').trim();
  const attraction = tourApiContentId
    ? await getAttractionDetail(env, { contentId: tourApiContentId }, fetchImpl)
    : null;

  const topic = String(input?.topic || attraction?.title || '').trim();
  if (!topic) throw Object.assign(new Error('WRITER_TOPIC_REQUIRED'), { status: 400 });

  const research = attraction
    ? buildTourApiResearch(attraction)
    : await collectWriterResearch(env, {
      topic,
      language,
      researchMode: input?.researchMode || 'auto'
    }, fetchImpl);
  const rolePrompt = await loadMasterV45RolePrompt('writer');
  const cloudflareModel = env.WRITER_MODEL || '@cf/openai/gpt-oss-120b';
  const geminiModel = env.GEMINI_WRITER_MODEL || GEMINI_DEFAULT_MODEL;
  const systemInstruction = `${rolePrompt.text}\n\n--- SERVER AUTOMATION ADAPTER ---\n${WRITER_ADAPTER}`;
  const userContent = JSON.stringify({
    platform: 'Blogger',
    blogId: String(input?.blogId || ''),
    topic,
    language,
    candidateAttempt: Number(input?.candidateAttempt || 1),
    retryReason: input?.retryReason ? String(input.retryReason) : null,
    rewriteExisting: input?.rewriteExisting === true,
    ...(Array.isArray(input?.internalLinkCandidates) && input.internalLinkCandidates.length
      ? { internalLinkCandidates: input.internalLinkCandidates.slice(0, 12) }
      : {}),
    // Counted in code so the writer is given the target rather than asked to estimate it.
    lengthContract: lengthContract(language, input?.seoBrief?.planning?.recommendedDepth),
    ...(input?.rewriteExisting === true && input?.rewriteSource && typeof input.rewriteSource === 'object' ? { rewriteSource: input.rewriteSource } : {}),
    ...(input?.seoBrief && typeof input.seoBrief === 'object' ? { seoBrief: input.seoBrief } : {}),
    research: research.used ? {
      provider: research.provider,
      retrievedAt: research.retrievedAt,
      results: research.results
    } : {
      provider: research.provider,
      requested: research.requested,
      unavailable: research.requested && !research.used
    }
  });
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET.writer
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET.writer,
      thinking: 'minimal'
    }
  }, aiBinding, fetchImpl, (parsed) => validateWriterArticle(parsed, { topic, language }));

  let parsed;
  try { parsed = parseJsonText(result.response); } catch {
    throw Object.assign(new Error('WRITER_JSON_INVALID'), { status: 502, meta: MASTER_V45 });
  }
  const article = validateWriterArticle(parsed, { topic, language });
  delete article.evidence;
  // The attraction's own real photos (from TourAPI's detailImage2) ride along here so a
  // TourAPI-grounded job can use them for body images instead of an AI-generated substitute
  // -- without this, generateSourceImage() has no idea real photos exist and always falls
  // back to generating a plausible-looking stand-in scene from the prompt text alone.
  const attractionImages = Array.isArray(attraction?.images)
    ? attraction.images.filter((url) => /^https:\/\//i.test(String(url || ''))).slice(0, 8)
    : [];
  return {
    article,
    ...providerMetadata(result),
    ...(attractionImages.length ? { attractionImages } : {}),
    research: {
      requested: research.requested,
      used: research.used,
      provider: research.provider,
      resultCount: research.resultCount
    },
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta
  };
}

export async function critic(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const rolePrompt = await loadMasterV45RolePrompt('critic');
  const cloudflareModel = env.CRITIC_MODEL || '@cf/openai/gpt-oss-120b';
  const article = input?.article && typeof input.article === 'object' ? input.article : input;
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw Object.assign(new Error('CRITIC_ARTICLE_REQUIRED'), { status: 400 });
  }

  const systemInstruction = `${rolePrompt.text}\n\n--- MASTER V4.5 CRITIC ADAPTER ---\n${CRITIC_SYSTEM}\n\n${CRITIC_MASTER_ADAPTER}`;
  // Measured here, from the article in hand. Until now both the writer and the critic were asked
  // to estimate this, and between them they let a 1,500-2,500 word band publish at a median of 873.
  const measuredLength = lengthVerdict(
    article,
    article?.language,
    input?.seoBrief?.planning?.recommendedDepth
  );
  const userContent = JSON.stringify({
    article: stripEvidence(article),
    measuredLength,
    ...(input?.seoBrief && typeof input.seoBrief === 'object' ? { seoBrief: input.seoBrief } : {})
  });
  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userContent }
  ];
  // Critic used to run on Gemini exclusively, then briefly on Workers AI only -- both put
  // it on the exact same model as (or same family as) writer/repair, which undermines
  // independent review: a model is a poor judge of its own output. Critic now runs on
  // free-ai (qwen7b) as primary, a genuinely distinct model from both Cloudflare's
  // gpt-oss-120b (writer/repair) and Gemini, falling back to Cloudflare only if free-ai
  // itself is unavailable or returns unparseable output. Gemini stays fully excluded.
  let result;
  let parsed;
  if (freeAiFallbackEnabled(env) && freeAiConfigured(env)) {
    try {
      const raw = await runFreeAi(env, {
        model: freeAiModel(env, 'critic'),
        messages,
        maxTokens: OUTPUT_TOKEN_BUDGET.critic,
        responseFormat: { type: 'json_object' }
      }, fetchImpl);
      // Validate the full contract here, not just parseability: a 7B primary very often
      // returns syntactically valid JSON in the wrong shape, and until 2026-09-20 that case
      // was the one failure the Cloudflare fallback could not rescue, because normalization
      // ran after this block had already committed to free-ai's answer. Jobs 165 and 172 both
      // died that way (CRITIC_SCHEMA_INVALID / CRITIC_ISSUE_SCHEMA_INVALID) with 120b idle.
      parsed = normalizeCriticResult(parseJsonText(raw.response));
      result = { ...raw, provider: 'free-ai', fallbackUsed: false, primaryError: null };
    } catch (error) {
      if (!shouldFallbackFromFreeAi(error) && !isCriticContractError(error)) throw error;
      const raw = await runWorkersAi(env, { model: cloudflareModel, messages, maxTokens: OUTPUT_TOKEN_BUDGET.critic }, aiBinding);
      // No third provider: a contract error from Cloudflare still throws, exactly as before.
      parsed = normalizeCriticResult(parseJsonText(raw.response));
      result = { ...raw, provider: 'cloudflare-workers-ai', fallbackUsed: true, primaryError: String(error.message) };
    }
  } else {
    const raw = await runWorkersAi(env, { model: cloudflareModel, messages, maxTokens: OUTPUT_TOKEN_BUDGET.critic }, aiBinding);
    result = { ...raw, provider: 'cloudflare-workers-ai', fallbackUsed: false, primaryError: null };
    parsed = normalizeCriticResult(parseJsonText(result.response));
  }

  return {
    ...parsed,
    measuredLength,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    auditMode: 'master-v4.5-role-critic-free-ai-granular'
  };
}

export async function repair(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const rolePrompt = await loadMasterV45RolePrompt('repair');
  const cloudflareModel = env.REPAIR_MODEL || '@cf/openai/gpt-oss-120b';
  const geminiModel = env.GEMINI_REPAIR_MODEL || GEMINI_DEFAULT_MODEL;
  const systemInstruction = `${rolePrompt.text}\n\n--- MASTER V4.5 REPAIR ADAPTER ---\n${REPAIR_SYSTEM}\n\n${REPAIR_MASTER_ADAPTER}`;
  const repairArticle = input?.article && typeof input.article === 'object' ? input.article : null;
  const userContent = JSON.stringify({
    ...input,
    strategy: 'targeted_sections_only',
    ...(repairArticle ? {
      measuredLength: lengthVerdict(repairArticle, repairArticle.language, input?.seoBrief?.planning?.recommendedDepth)
    } : {})
  });
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET.repair
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET.repair,
      thinking: 'medium'
    }
  }, aiBinding, fetchImpl);
  let parsed;
  try { parsed = parseJsonText(result.response); } catch {
    throw Object.assign(new Error('REPAIR_JSON_INVALID'), { status: 502, meta: MASTER_V45 });
  }
  const article = validateRepairArticle(mergeRepairArticle(parsed, input), input);
  return {
    article,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    repairMode: 'master-v4.5-role-targeted'
  };
}
