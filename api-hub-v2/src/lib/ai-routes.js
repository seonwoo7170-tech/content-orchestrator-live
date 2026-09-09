import { runWorkersAi } from './cloudflare-ai.js';
import { runGeminiAi } from './gemini-ai.js';
import { runPrimaryWithGeminiFallback } from './ai-provider-router.js';
import { MASTER_V45, parseJsonText } from './contracts.js';
import { loadMasterV45RolePrompt } from './master-v45-role-prompts.js';
import { collectWriterResearch } from './tavily-search.js';

const WRITER_ADAPTER = `AUTOMATION WRITER ADAPTER — this adapter overrides any interactive/questioning flow in the master prompt for this server call.
Platform is Google Blogger / Blogspot. Do not ask questions. Do not wait for user selection. Produce one complete publication-ready Article from the supplied topic and language.
Return JSON only with this exact top-level shape: {"article":{"title":"...","html":"...","searchDescription":"...","labels":["..."],"sources":[...],"language":"ko|en","topic":"..."}}.
The html field must contain only the Blogger post body, not <html>, <head>, or <body>. The title field is the Blogger post title and the Blogger theme/page template supplies the page-level heading; do not duplicate the title as an <h1> inside html. For language=en, write a natural search-oriented English title and do not default to "How to". Use "How to" only when the reader is genuinely looking for a procedural or step-by-step task. For explanation, diagnosis, comparison, selection, timing, cost, suitability, definition, or troubleshooting intent, choose the most natural title form for the query, including Why, What, Which, When, Can, Should, Is/Are, Does/Do, How Much, How Long, How Often, or a concise non-question title. Avoid formulaic repetition and preserve the supplied topic/search intent rather than forcing an awkward question word. Use <h2> for the first body section heading when a heading is needed. Do not use placeholders, invented URLs, invented quotations, invented first-hand experience, or unsupported current claims. Keep prose practical, answer-first, skimmable, and less academic/manual-like. If current facts cannot be verified from the supplied context, avoid asserting them as current facts. SearchDescription must be concise plain text. labels and sources must always be arrays.
CONTENT COMPLETENESS GATE — before producing the final JSON, silently identify the reader's primary decision or action and the essential subquestions that must be answered for that reader to act confidently. A valid structure is not enough. Cover every applicable core dimension with concrete, non-redundant substance: the direct answer or recommendation; why it works or what causes the problem when relevant; decision criteria and meaningful trade-offs; practical steps in the order they should be done; prerequisites, materials, cost/time factors or setup requirements when relevant; safety limits, exceptions and cases where the advice should not be used; common failure modes or mistakes; and at least one concrete example, checkpoint, or decision rule when it materially improves understanding. Omit only dimensions that are genuinely irrelevant to the topic. Do not pad to reach a word count. Use the available output budget for information gain, examples, boundaries and actionable detail rather than filler. Never omit a core answer merely to keep the article short. If a necessary current fact cannot be supported, state the limitation or use stable guidance instead of inventing it.
When a research object is supplied, treat it as the only web research performed for this request. Ground time-sensitive/current claims in those records, prefer primary or official sources when present, and never invent a source beyond the supplied research URLs. The Article.sources field must contain only sources actually used. When research was requested but unavailable, do not present unverifiable information as current fact; reframe the article around stable guidance or explicitly bounded information.
When seoBrief is supplied, use it as planning and search-intent context: follow its searchIntent, intentGoal, answerFirst, information-gain, freshness, internal-link and cannibalization guidance where applicable. SEO brief metrics are evidence for planning, not article facts to quote or invent. Never force keyword density, fixed word count, or unsupported claims merely to satisfy the brief.
When rewriteExisting is true, this is an in-place modernization of an existing Blogger post, not a patch and not a new post. Use rewriteSource only to preserve the same core subject, primary search intent, language, and important title terms. Rewrite the entire body from scratch under the current Master v4.5 and CONTENT COMPLETENESS GATE instead of imitating or lightly editing the old prose. The title may be improved modestly for clarity, natural wording, and search intent, but must remain recognizably about the same subject; do not pivot to a different angle merely to make it sound new. Do not copy old boilerplate. Do not output, alter, or invent Blogger identity fields, URLs, or post IDs; the caller preserves the existing post identity and will update that same post.
If candidateAttempt is greater than 1, this is a last-resort fresh candidate after targeted repairs were exhausted. Preserve the same topic and search intent, but produce a genuinely fresh candidate instead of echoing the failed wording. Use retryReason only as a failure signal to avoid repeating the same defect; do not mention retry mechanics in the article.`;

const CRITIC_SYSTEM = `You are a strict publication critic. Return JSON only. Evaluate factual reliability, source quality, search-intent fit, practical usefulness, substantive completeness, readability, platform-safe HTML, and whether the prose is overly academic or manual-like. Schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable article field or html block","reason":"specific reason","repairInstruction":"specific minimal repair"}]}. PASS requires zero issues. FAIL requires at least one issue. Do not invent facts or sources.`;

const CRITIC_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 COMPLIANCE CRITIC ADAPTER — this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding Master v4.5 Critic role prompt as the governing publication requirements and as a reference checklist. Do NOT execute a writer workflow. Audit the supplied Article against every applicable requirement in the Critic role prompt, not merely broad writing quality.

This server call is specifically for Google Blogger / Blogspot. The Article.title field is the Blogger post title and is rendered by the Blogger page/theme outside Article.html. Therefore absence of an <h1> element inside Article.html is NOT a defect and must never be reported as MISSING_H1_IN_HTML or an equivalent issue. A duplicate title <h1> inside the Blogger body is not required. Treat <h2> as the normal first section-heading level in Article.html.

Perform a strict compliance pass across all applicable areas, including article purpose and search intent, answer-first usefulness, factual reliability and unsupported claims, source/citation integrity, title and description quality, heading/section logic, readability and sentence density, repetition and filler, AI-like or overly academic/manual-like prose, practical usefulness, substantive completeness, tables/lists where appropriate, Blogger-safe HTML, labels, language consistency, prohibited fabrication, and every other applicable rule stated in the Critic role prompt.

CONTENT COMPLETENESS PASS — independently derive the reader's primary decision/action and the essential subquestions implied by the Article.title, topic, and seoBrief when supplied. Do not PASS an article merely because its headings and structure look complete. Verify that the body actually supplies enough concrete information for a reader to act or decide: the direct answer; applicable reasoning or cause; decision criteria/trade-offs; executable steps; relevant prerequisites/cost/time/material considerations; exceptions/safety/boundaries; common failure modes; and concrete examples/checkpoints where they materially improve the answer. Only require dimensions that are genuinely relevant to the topic. If a materially necessary core answer is missing or too vague to support action, emit code CORE_INFORMATION_MISSING. Point that issue to the single existing machine-targetable HTML block that should be expanded or replaced to supply the missing information, preferably the nearest relevant paragraph or heading block. Never use "article body" or another coarse location. The repair instruction must name the missing decision/action information, not ask for generic length or filler.

When seoBrief is supplied, also audit the Article against applicable brief constraints such as search intent, answer-first usefulness, information gain, freshness/source requirements, internal-link intent and cannibalization avoidance. Treat brief metrics as planning evidence only, never as facts the Article was required to repeat. Do not invent a violation when the brief requirement is not applicable to the specific Article.

Run the audit as separate passes and do not collapse materially different violations into one issue. A distinct repair action must receive a distinct issue. Independently inspect at minimum: (1) title exaggeration, clickbait, guarantees, or unsupported certainty; (2) unsupported absolute claims in the body; (3) fabricated or unsupported statistics; (4) fabricated, placeholder, invalid, or unverifiable source names and URLs visible in the Article; (5) unsafe, destructive, or operationally risky instructions; (6) repetition and filler; (7) malformed or unsafe HTML; (8) misleading or overclaiming searchDescription; (9) substantive completeness and missing core decision/action information; and (10) every other applicable Master v4.5 violation. Consolidate only exact duplicates of the same defect.

Do not reward fluent prose by assuming compliance. Actively look for concrete violations. Do not invent violations, facts, sources, or external verification. If a rule is genuinely not applicable, do not penalize it. If external verification is unavailable, never pretend that you browsed the web; judge whether the Article itself provides adequate support and whether claims are framed safely.

LOCATION CONTRACT — every issue.location must be machine-targetable. For Article.html, enumerate the supported top-level blocks <p>, <h2>, <h3>, <li>, and <blockquote> in one shared document-order sequence starting at 1, then use exactly: "html p N", "html h2 N", "html h3 N", "html li N", or "html blockquote N". N is the shared document-order block number, not a per-tag counter. For non-HTML fields use exactly one of: "title", "searchDescription", "labels", "sources", "language", or "topic". Never use only a heading title, prose fragment, "introduction", "conclusion", "section-1", "body", or another human-only location. If two different HTML blocks need changes, emit separate issues with their exact locations.

Return JSON only using exactly this schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable location from the LOCATION CONTRACT","reason":"specific Master v4.5 compliance reason","repairInstruction":"specific minimal repair that preserves unaffected content"}]}.

PASS is allowed only when score is at least 95 AND issues is empty. Any concrete issue means FAIL, even if the numeric score is 95 or higher. FAIL must contain at least one issue. Each issue must identify a precise location and an actionable minimal repair. Return all concrete issues you can support from the supplied Article itself.`;

const REPAIR_SYSTEM = `You are a targeted repair editor. Return JSON only. Repair ONLY the exact locations identified by critic issues. Treat each issue.location as a hard edit boundary. Preserve unaffected content byte-for-byte whenever possible, preserve original meaning, Blogger identity fields, language, title unless explicitly flagged, and all verified sources. Never fabricate experience, facts, statistics, URLs, or citations. Return the complete repaired Article object.`;

const REPAIR_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 TARGETED REPAIR ADAPTER — this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding Master v4.5 Repair role prompt as governing constraints while repairing the supplied Article. Apply every supplied critic issue, but change only the smallest affected sections necessary. Do not rewrite clean sections merely for style preference. A repair must not introduce a new Master v4.5 violation elsewhere.
The supplied issue.location values are hard edit boundaries. For HTML locations such as "html p 3" or "html h2 5", change only those exact document-order blocks. Do not reformat, reorder, normalize whitespace, change tags, or rewrite any unflagged HTML block. For field locations such as "title" or "searchDescription", change only that field. Return all unflagged Article fields and all unflagged HTML exactly as received.
For CORE_INFORMATION_MISSING, use the flagged block to add the specific missing decision rule, step, boundary, trade-off, prerequisite, or example named by the issue. Add concrete useful information, not generic filler or a longer restatement. Stay within the hard edit boundary and use only supplied/verified facts or stable guidance; if the missing fact cannot be supported, state the limitation rather than inventing it.
When seoBrief is supplied, preserve its applicable search-intent and information-gain goals while making only the flagged repair. Do not use the brief as permission to change unflagged sections or to invent unsupported facts.
This is Google Blogger / Blogspot: Article.title is rendered outside Article.html, so do not add a duplicate <h1> to the body merely because the body has no <h1>.
Return the complete repaired Article object as JSON only. Either a direct Article object or {"article": Article} is accepted by the server, but do not add prose outside JSON. Preserve title, topic, language, labels, sources, searchDescription, and unaffected HTML unless an issue specifically requires changing them. Never fabricate first-hand experience, facts, statistics, quotations, URLs, sources, or current claims.`;

const OUTPUT_TOKEN_BUDGET = Object.freeze({
  diagnostic: 256,
  writer: 12288,
  critic: 12288,
  repair: 12288
});

const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const CRITIC_PASS_MIN_SCORE = 95;
const CRITIC_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CRITIC_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'FAIL'] },
    score: { type: 'number', minimum: 0, maximum: 100 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          location: { type: 'string' },
          reason: { type: 'string' },
          repairInstruction: { type: 'string' }
        },
        required: ['code', 'severity', 'location', 'reason', 'repairInstruction']
      }
    }
  },
  required: ['status', 'score', 'issues']
});

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

function validateCriticIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (typeof issue.code !== 'string' || !issue.code.trim()) return false;
  if (!CRITIC_SEVERITIES.has(issue.severity)) return false;
  if (typeof issue.location !== 'string' || !issue.location.trim()) return false;
  if (typeof issue.reason !== 'string' || !issue.reason.trim()) return false;
  if (typeof issue.repairInstruction !== 'string' || !issue.repairInstruction.trim()) return false;
  return true;
}

function normalizeCriticResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || !['PASS', 'FAIL'].includes(parsed.status)) {
    throw Object.assign(new Error('CRITIC_SCHEMA_INVALID'), { status: 502 });
  }

  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw Object.assign(new Error('CRITIC_SCORE_INVALID'), { status: 502 });
  }

  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  if (!issues.every(validateCriticIssue)) {
    throw Object.assign(new Error('CRITIC_ISSUE_SCHEMA_INVALID'), { status: 502 });
  }
  if (parsed.status === 'FAIL' && issues.length === 0) {
    throw Object.assign(new Error('CRITIC_FAIL_WITHOUT_ISSUES'), { status: 502 });
  }

  if (issues.length > 0) {
    return {
      ...parsed,
      score,
      status: 'FAIL',
      issues,
      contractNormalized: parsed.status === 'PASS' ? 'PASS_WITH_ISSUES_TO_FAIL' : undefined
    };
  }

  if (score < CRITIC_PASS_MIN_SCORE) {
    throw Object.assign(new Error('CRITIC_PASS_SCORE_BELOW_THRESHOLD'), { status: 502 });
  }

  return { ...parsed, score, status: 'PASS', issues };
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
  const topic = String(input?.topic || '').trim();
  const language = String(input?.language || '').trim();
  if (!topic) throw Object.assign(new Error('WRITER_TOPIC_REQUIRED'), { status: 400 });
  if (!['ko', 'en'].includes(language)) throw Object.assign(new Error('WRITER_LANGUAGE_INVALID'), { status: 400 });

  const research = await collectWriterResearch(env, {
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
  return {
    article,
    ...providerMetadata(result),
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
  const geminiModel = env.GEMINI_CRITIC_MODEL || GEMINI_DEFAULT_MODEL;
  const article = input?.article && typeof input.article === 'object' ? input.article : input;
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw Object.assign(new Error('CRITIC_ARTICLE_REQUIRED'), { status: 400 });
  }

  const systemInstruction = `${rolePrompt.text}\n\n--- MASTER V4.5 CRITIC ADAPTER ---\n${CRITIC_SYSTEM}\n\n${CRITIC_MASTER_ADAPTER}`;
  const userContent = JSON.stringify({
    article,
    ...(input?.seoBrief && typeof input.seoBrief === 'object' ? { seoBrief: input.seoBrief } : {})
  });
  const result = await runPrimaryWithGeminiFallback({ ...env, TEXT_PRIMARY_PROVIDER: 'gemini' }, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET.critic
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET.critic,
      responseSchema: CRITIC_RESPONSE_SCHEMA,
      thinking: 'medium'
    }
  }, aiBinding, fetchImpl);

  const parsed = normalizeCriticResult(parseJsonText(result.response));
  return {
    ...parsed,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    auditMode: 'master-v4.5-role-critic-gemini-granular'
  };
}

export async function repair(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const rolePrompt = await loadMasterV45RolePrompt('repair');
  const cloudflareModel = env.REPAIR_MODEL || '@cf/openai/gpt-oss-120b';
  const geminiModel = env.GEMINI_REPAIR_MODEL || GEMINI_DEFAULT_MODEL;
  const systemInstruction = `${rolePrompt.text}\n\n--- MASTER V4.5 REPAIR ADAPTER ---\n${REPAIR_SYSTEM}\n\n${REPAIR_MASTER_ADAPTER}`;
  const userContent = JSON.stringify({ ...input, strategy: 'targeted_sections_only' });
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
  const article = validateRepairArticle(parsed, input);
  return {
    article,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    repairMode: 'master-v4.5-role-targeted'
  };
}
