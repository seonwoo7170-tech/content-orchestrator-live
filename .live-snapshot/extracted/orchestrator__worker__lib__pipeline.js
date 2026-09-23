// worker/lib/pipeline.js
var DEFAULT_MAX_TARGETED_REPAIRS = 2;
var DEFAULT_MAX_NEW_ARTICLE_CANDIDATES = 2;
var TARGETED_REPAIR = "targeted_sections_only";
var CONTINUATION_REWRITE = "targeted_sections_rewrite";
var STRUCTURAL_REPLAN_CODES = /* @__PURE__ */ new Set([
  "LOW_INFORMATION_GAIN",
  "OUTLINE_REDESIGN_REQUIRED",
  "STRUCTURAL_COMPLETENESS_GAP",
  "ARTICLE_TOO_THIN",
  // Inserting a lead paragraph adds a block, which targeted repair can never do -- see below.
  "MISSING_LEAD_PARAGRAPH"
]);
var REPAIR_INAPPLICABLE_CODES = /* @__PURE__ */ new Set([
  ...STRUCTURAL_REPLAN_CODES,
  "CORE_INFORMATION_MISSING",
  // Same shape, found on job 172's first clean run after the filter landed: "add a footnote
  // after the paragraph ... include the footnote text at the end" is a block insertion, so it
  // failed the guard and took the round with it even though the filter had already rescued the
  // rest of that batch (score 45 -> 85, eight findings down to four).
  "MISSING_FOOTNOTE_CONTENT"
]);
function repairableIssues(issues) {
  return Array.isArray(issues) ? issues : [];
}
__name(repairableIssues, "repairableIssues");
async function resolveInternalLinkCandidates(env, blogId) {
  if (!blogId) return [];
  try {
    return await selectInternalLinkCandidates(env, blogId, { limit: 12 });
  } catch {
    return [];
  }
}
__name(resolveInternalLinkCandidates, "resolveInternalLinkCandidates");
async function emitStage(hooks, stage, meta2) {
  if (typeof hooks?.onStage === "function") await hooks.onStage(stage, meta2);
}
__name(emitStage, "emitStage");
function htmlWordCount(html) {
  const text4 = String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return text4.split(/\s+/).filter(Boolean).length;
}
__name(htmlWordCount, "htmlWordCount");
function boundedInteger(value, fallback, min, max2) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max2, Math.max(min, parsed));
}
__name(boundedInteger, "boundedInteger");
function maxTargetedRepairs(env) {
  return boundedInteger(env?.TARGETED_REPAIR_MAX_ATTEMPTS, DEFAULT_MAX_TARGETED_REPAIRS, 2, 2);
}
__name(maxTargetedRepairs, "maxTargetedRepairs");
function maxNewArticleCandidates(env) {
  return boundedInteger(env?.NEW_ARTICLE_MAX_CANDIDATES, DEFAULT_MAX_NEW_ARTICLE_CANDIDATES, 1, 2);
}
__name(maxNewArticleCandidates, "maxNewArticleCandidates");
function isRepairGuardError(error) {
  return String(error?.code || error?.message || "").startsWith("TARGETED_REPAIR_");
}
__name(isRepairGuardError, "isRepairGuardError");
function issueKey(issue3) {
  return `${String(issue3?.code || "").trim().toUpperCase()}|${String(issue3?.location || "").trim().toLowerCase()}`;
}
__name(issueKey, "issueKey");
function structuralReplanRequired(critic) {
  const issues = Array.isArray(critic?.issues) ? critic.issues : [];
  const codes = issues.map((issue3) => String(issue3?.code || "").trim().toUpperCase()).filter(Boolean);
  if (codes.some((code) => STRUCTURAL_REPLAN_CODES.has(code))) return true;
  if (critic?.measuredLength?.belowFloor) return false;
  return codes.filter((code) => code === "CORE_INFORMATION_MISSING").length >= 2;
}
__name(structuralReplanRequired, "structuralReplanRequired");
function retryReasonForEvaluation(evaluation) {
  if (!evaluation) return null;
  if (evaluation.reviewReason === "MASTER_REPLAN_REQUIRED") {
    return "MASTER_REPLAN_REQUIRED: the previous candidate lacked information gain or multiple core decision/action details. Re-plan the outline from the seoBrief before drafting and add concrete decision criteria, exceptions, checkpoints, and practical depth instead of patching the previous structure.";
  }
  return evaluation.reviewReason || null;
}
__name(retryReasonForEvaluation, "retryReasonForEvaluation");
function escalatedRepairIssues(issues, context = {}) {
  if (context.repairStrategy !== CONTINUATION_REWRITE) return issues;
  const priorKeys = new Set((Array.isArray(context.priorIssues) ? context.priorIssues : []).map(issueKey));
  return (Array.isArray(issues) ? issues : []).map((issue3) => {
    const repeated = priorKeys.has(issueKey(issue3));
    const escalation = repeated ? "The same defect survived an earlier targeted repair. Replace the entire exact flagged block with fresh concise wording that fully resolves this issue; do not make another cosmetic or sentence-level tweak." : "This is a continuation after earlier targeted repairs were exhausted. Rewrite the entire exact flagged block as needed to satisfy this issue while preserving its meaning.";
    return {
      ...issue3,
      repairInstruction: `${String(issue3?.repairInstruction || "").trim()} ${escalation}`.trim()
    };
  });
}
__name(escalatedRepairIssues, "escalatedRepairIssues");
function styleLintSummary(initialLint, history) {
  const latest = history.length ? history[history.length - 1].lint : initialLint;
  const preCriticStyle = history.find((item) => item.phase === "pre_critic_style_repair")?.lint ?? initialLint;
  const afterCriticRepair = history.find((item) => item.phase === "after_critic_repair")?.lint ?? null;
  const afterPostRepairStyleRepair = [...history].reverse().find((item) => item.phase === "post_critic_style_repair")?.lint ?? null;
  return {
    beforeCritic: initialLint,
    afterStyleRepair: preCriticStyle,
    afterCriticRepair,
    afterPostRepairStyleRepair,
    final: latest,
    history
  };
}
__name(styleLintSummary, "styleLintSummary");
async function criticCheck(env, article, fetchImpl, hooks, context, criticCheckCount, stageMeta) {
  await emitStage(hooks, criticCheckCount === 0 ? "critic_review" : "final_critic", stageMeta);
  return validateCriticResult(await callHub(
    env,
    env.HUB_CRITIC_PATH || "/api/hub/ai/critic",
    {
      article,
      stage: criticCheckCount === 0 ? context.initialCriticStage : context.retryCriticStage,
      ...context.sourcePost ? { sourcePost: context.sourcePost } : {},
      ...context.seoBrief ? { seoBrief: context.seoBrief } : {}
    },
    fetchImpl
  ));
}
__name(criticCheck, "criticCheck");
function resolveAfterAdvisoryReview(outcome) {
  const deterministicQa = runDeterministicQualityGate(outcome.article);
  if (!deterministicQaAllowsPublish(deterministicQa)) {
    return { ...outcome, status: "FAIL", deterministicQa, reviewReason: "DETERMINISTIC_QA_BLOCKED" };
  }
  const critic = outcome.finalCritic || null;
  return {
    ...outcome,
    status: "PASS",
    deterministicQa,
    advisoryReview: {
      haltedOn: outcome.reviewReason ?? null,
      criticStatus: critic?.status ?? null,
      criticScore: critic?.score ?? critic?.totalScore ?? null,
      // Counted in api-hub, not estimated. Carried onto the job record so a published article's
      // length against the floor it was planned for is visible without re-deriving it.
      measuredLength: critic?.measuredLength ?? null,
      issues: Array.isArray(critic?.issues) ? critic.issues : [],
      styleLint: outcome.styleLint ?? null
    },
    reviewReason: null
  };
}
__name(resolveAfterAdvisoryReview, "resolveAfterAdvisoryReview");
async function qualityLoop(env, initialArticle, fetchImpl, hooks, context) {
  const maxRepairs = maxTargetedRepairs(env);
  const repairStrategy = context.repairStrategy || TARGETED_REPAIR;
  let article = initialArticle;
  const initialLint = lintNaturalWriting(article);
  let currentLint = initialLint;
  const lintHistory = [{ phase: "initial", lint: initialLint }];
  let repairAttempts = 0;
  let repairApplied = false;
  let styleRepairApplied = false;
  let criticCheckCount = 0;
  let initialCritic = null;
  let finalCritic = null;
  const repairGuardViolations = [];
  let pendingStageMeta = null;
  while (true) {
    let issueSource;
    let issues;
    if (currentLint.status === "BLOCK") {
      issueSource = "linter";
      issues = currentLint.blockingIssues;
    } else {
      const critic = await criticCheck(env, article, fetchImpl, hooks, context, criticCheckCount, pendingStageMeta);
      pendingStageMeta = null;
      if (!initialCritic) initialCritic = critic;
      finalCritic = critic;
      criticCheckCount += 1;
      if (critic.status === "PASS") {
        return {
          status: "PASS",
          article,
          initialCritic,
          finalCritic,
          repairApplied,
          styleRepairApplied,
          repairAttempts,
          repairStrategy,
          repairGuardViolations,
          styleLint: styleLintSummary(initialLint, lintHistory)
        };
      }
      if (context.structuralReplanOnCritic === true && structuralReplanRequired(critic)) {
        return resolveAfterAdvisoryReview({
          status: "FAIL",
          article,
          initialCritic,
          finalCritic,
          repairApplied,
          styleRepairApplied,
          repairAttempts,
          repairStrategy,
          repairGuardViolations,
          styleLint: styleLintSummary(initialLint, lintHistory),
          reviewReason: "MASTER_REPLAN_REQUIRED"
        });
      }
      issueSource = "critic";
      issues = critic.issues;
      pendingStageMeta = {
        criticStatus: critic.status,
        criticProvider: critic.provider ?? null,
        criticScore: critic.score ?? critic.totalScore ?? null,
        issueCount: Array.isArray(issues) ? issues.length : 0,
        issueLocations: Array.isArray(issues) ? issues.map((issue3) => issue3?.location ?? null).slice(0, 10) : []
      };
    }
    if (repairAttempts >= maxRepairs) {
      return resolveAfterAdvisoryReview({
        status: "FAIL",
        article,
        initialCritic,
        finalCritic,
        repairApplied,
        styleRepairApplied,
        repairAttempts,
        repairStrategy,
        repairGuardViolations,
        styleLint: styleLintSummary(initialLint, lintHistory),
        reviewReason: issueSource === "linter" ? "NATURAL_WRITING_LINT_BLOCKED_AFTER_MAX_TARGETED_REPAIRS" : "CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS"
      });
    }
    const applicableIssues = repairableIssues(issues);
    if (applicableIssues.length === 0) {
      return resolveAfterAdvisoryReview({
        status: "FAIL",
        article,
        initialCritic,
        finalCritic,
        repairApplied,
        styleRepairApplied,
        repairAttempts,
        repairStrategy,
        repairGuardViolations,
        styleLint: styleLintSummary(initialLint, lintHistory),
        reviewReason: "STRUCTURAL_REPLAN_REQUIRED"
      });
    }
    let repairSucceeded = false;
    while (!repairSucceeded && repairAttempts < maxRepairs) {
      await emitStage(hooks, issueSource === "linter" ? "style_repairing" : "repairing", pendingStageMeta);
      pendingStageMeta = null;
      repairAttempts += 1;
      const beforeRepair = article;
      const beforeRepairWordCount = htmlWordCount(beforeRepair.html);
      const repairIssues = escalatedRepairIssues(applicableIssues, context);
      try {
        const repair = await callHub(
          env,
          env.HUB_REPAIR_PATH || "/api/hub/ai/repair",
          {
            article: beforeRepair,
            issues: repairIssues,
            strategy: repairStrategy,
            continuationAttempt: Number(context.continuationAttempt || 0),
            repairAttempt: repairAttempts,
            maxRepairAttempts: maxRepairs,
            ...context.sourcePost ? { sourcePost: context.sourcePost } : {},
            ...context.preserve ? { preserve: context.preserve } : {},
            ...context.seoBrief ? { seoBrief: context.seoBrief } : {}
          },
          fetchImpl
        );
        const candidateArticle = validateArticle(repair.article ?? repair);
        const repairedArticle = validateArticle(constrainTargetedRepair(beforeRepair, candidateArticle, repairIssues));
        assertTargetedRepairPreserved(beforeRepair, repairedArticle, repairIssues);
        article = repairedArticle;
        repairApplied = true;
        if (issueSource === "linter") styleRepairApplied = true;
        repairSucceeded = true;
        pendingStageMeta = {
          repairAttempt: repairAttempts,
          repairIssueCount: repairIssues.length,
          wordCountBefore: beforeRepairWordCount,
          wordCountAfter: htmlWordCount(article.html)
        };
      } catch (error) {
        if (!isRepairGuardError(error)) throw error;
        repairGuardViolations.push({
          attempt: repairAttempts,
          code: String(error.code || error.message),
          meta: error.meta ?? null
        });
        if (repairAttempts >= maxRepairs) {
          return resolveAfterAdvisoryReview({
            status: "FAIL",
            article,
            initialCritic,
            finalCritic,
            repairApplied,
            styleRepairApplied,
            repairAttempts,
            repairStrategy,
            repairGuardViolations,
            styleLint: styleLintSummary(initialLint, lintHistory),
            reviewReason: "TARGETED_REPAIR_SCOPE_VIOLATION"
          });
        }
      }
    }
    if (!repairSucceeded) {
      return resolveAfterAdvisoryReview({
        status: "FAIL",
        article,
        initialCritic,
        finalCritic,
        repairApplied,
        styleRepairApplied,
        repairAttempts,
        repairStrategy,
        repairGuardViolations,
        styleLint: styleLintSummary(initialLint, lintHistory),
        reviewReason: "TARGETED_REPAIR_EXHAUSTED"
      });
    }
    currentLint = lintNaturalWriting(article);
    const phase = issueSource === "critic" ? "after_critic_repair" : criticCheckCount > 0 ? "post_critic_style_repair" : "pre_critic_style_repair";
    lintHistory.push({ phase, lint: currentLint });
  }
}
__name(qualityLoop, "qualityLoop");
function readyResult(evaluation, extra = {}) {
  return {
    status: "READY",
    article: evaluation.article,
    initialCritic: evaluation.initialCritic,
    finalCritic: evaluation.finalCritic,
    repairApplied: evaluation.repairApplied,
    styleRepairApplied: evaluation.styleRepairApplied,
    repairAttempts: evaluation.repairAttempts,
    repairStrategy: evaluation.repairStrategy,
    repairGuardViolations: evaluation.repairGuardViolations,
    styleLint: evaluation.styleLint,
    // An article that ships with the critic still unsatisfied carries what it said. Dropping it
    // here would make "published" and "published clean" look identical in the job record, and
    // the point of the inversion is that the difference stays visible.
    ...evaluation.advisoryReview ? { advisoryReview: evaluation.advisoryReview } : {},
    ...evaluation.deterministicQa ? { deterministicQa: evaluation.deterministicQa } : {},
    ...extra
  };
}
__name(readyResult, "readyResult");
function reviewResult(evaluation, extra = {}) {
  return {
    status: "NEEDS_REVIEW",
    article: evaluation.article,
    initialCritic: evaluation.initialCritic,
    finalCritic: evaluation.finalCritic,
    repairApplied: evaluation.repairApplied,
    styleRepairApplied: evaluation.styleRepairApplied,
    repairAttempts: evaluation.repairAttempts,
    repairStrategy: evaluation.repairStrategy,
    repairGuardViolations: evaluation.repairGuardViolations,
    styleLint: evaluation.styleLint,
    reviewReason: evaluation.reviewReason || "TARGETED_REPAIR_EXHAUSTED",
    ...evaluation.deterministicQa ? { deterministicQa: evaluation.deterministicQa } : {},
    ...extra
  };
}
__name(reviewResult, "reviewResult");
function continuationMeta(priorResult, evaluation) {
  const continuationAttempt = Math.max(0, Number(priorResult?.continuationAttempt || 0)) + 1;
  const previousHistory = Array.isArray(priorResult?.continuationHistory) ? priorResult.continuationHistory : [];
  const continuationHistory = [
    ...previousHistory,
    {
      continuationAttempt,
      status: evaluation.status,
      reviewReason: evaluation.reviewReason ?? null,
      repairAttempts: evaluation.repairAttempts,
      repairStrategy: evaluation.repairStrategy,
      repairGuardViolationCount: evaluation.repairGuardViolations.length
    }
  ];
  const previousTotal = Number(
    priorResult?.totalRepairAttempts ?? priorResult?.repairAttempts ?? 0
  );
  return {
    continuationAttempt,
    continuationHistory,
    totalRepairAttempts: previousTotal + Number(evaluation.repairAttempts || 0)
  };
}
__name(continuationMeta, "continuationMeta");
async function runNewArticlePipeline(env, request, fetchImpl = fetch, hooks = {}) {
  const maxCandidates = maxNewArticleCandidates(env);
  const candidateHistory = [];
  let lastEvaluation = null;
  const seoBrief = request?.seoBrief || null;
  const internalLinkCandidates = await resolveInternalLinkCandidates(env, request?.blogId);
  for (let candidateAttempt = 1; candidateAttempt <= maxCandidates; candidateAttempt += 1) {
    if (candidateAttempt > 1) await emitStage(hooks, "candidate_regenerating");
    const writer = await callHub(
      env,
      env.HUB_WRITER_PATH || "/api/hub/ai/writer",
      {
        ...request,
        candidateAttempt,
        ...internalLinkCandidates.length ? { internalLinkCandidates } : {},
        ...lastEvaluation ? { retryReason: retryReasonForEvaluation(lastEvaluation) } : {}
      },
      fetchImpl
    );
    const writtenArticle = liftBlocksOutOfParagraphs(
      stripWriterOwnedImages(validateArticle(writer.article ?? writer))
    );
    const attractionImages = Array.isArray(writer.attractionImages) ? writer.attractionImages : null;
    const evaluation = await qualityLoop(env, writtenArticle, fetchImpl, hooks, {
      initialCriticStage: candidateAttempt === 1 ? "initial" : "regenerated_initial",
      retryCriticStage: candidateAttempt === 1 ? "final" : "regenerated_final",
      seoBrief,
      repairStrategy: TARGETED_REPAIR,
      structuralReplanOnCritic: true
    });
    lastEvaluation = evaluation;
    candidateHistory.push({
      candidateAttempt,
      status: evaluation.status,
      reviewReason: evaluation.reviewReason ?? null,
      repairAttempts: evaluation.repairAttempts,
      repairStrategy: evaluation.repairStrategy,
      repairGuardViolationCount: evaluation.repairGuardViolations.length
    });
    if (evaluation.status === "PASS") {
      return readyResult(evaluation, {
        candidateAttempt,
        candidateRegenerated: candidateAttempt > 1,
        candidateHistory,
        seoBrief,
        ...attractionImages ? { attractionImages } : {}
      });
    }
  }
  return reviewResult(lastEvaluation, {
    candidateAttempt: maxCandidates,
    candidateRegenerated: maxCandidates > 1,
    candidateHistory,
    seoBrief
  });
}
__name(runNewArticlePipeline, "runNewArticlePipeline");
async function runNewArticleContinuationPipeline(env, priorResult, fetchImpl = fetch, hooks = {}) {
  const article = liftBlocksOutOfParagraphs(validateArticle(priorResult?.article));
  const seoBrief = hooks?.seoBrief || priorResult?.seoBrief || null;
  const evaluation = await qualityLoop(env, article, fetchImpl, hooks, {
    initialCriticStage: "continued_initial",
    retryCriticStage: "continued_final",
    seoBrief,
    repairStrategy: CONTINUATION_REWRITE,
    continuationAttempt: Math.max(0, Number(priorResult?.continuationAttempt || 0)) + 1,
    priorIssues: priorResult?.finalCritic?.issues || []
  });
  const continuation = continuationMeta(priorResult, evaluation);
  const common = {
    candidateAttempt: Number(priorResult?.candidateAttempt || 1),
    candidateRegenerated: Boolean(priorResult?.candidateRegenerated),
    candidateHistory: Array.isArray(priorResult?.candidateHistory) ? priorResult.candidateHistory : [],
    seoBrief,
    ...continuation
  };
  return evaluation.status === "PASS" ? readyResult(evaluation, common) : reviewResult(evaluation, common);
}
__name(runNewArticleContinuationPipeline, "runNewArticleContinuationPipeline");
async function rewriteExistingArticle(env, sourcePost, seoBrief, fetchImpl, hooks) {
  const sourceArticle = validateArticle(sourcePost?.article);
  const identity = sourcePost?.identity || {};
  if (!identity?.blogId || !identity?.bloggerPostId) throw new Error("REPAIR_SOURCE_IDENTITY_MISSING");
  await emitStage(hooks, "writing");
  const rewriteSource = {
    title: sourceArticle.title,
    topic: sourceArticle.topic,
    searchDescription: sourceArticle.searchDescription,
    labels: sourceArticle.labels,
    language: sourceArticle.language
  };
  const internalLinkCandidates = await resolveInternalLinkCandidates(env, identity.blogId);
  const writer = await callHub(
    env,
    env.HUB_WRITER_PATH || "/api/hub/ai/writer",
    {
      blogId: String(identity.blogId),
      topic: String(sourceArticle.topic || sourceArticle.title),
      language: sourceArticle.language,
      rewriteExisting: true,
      rewriteSource,
      ...internalLinkCandidates.length ? { internalLinkCandidates } : {},
      ...seoBrief ? { seoBrief } : {}
    },
    fetchImpl
  );
  return validateArticle(writer.article ?? writer);
}
__name(rewriteExistingArticle, "rewriteExistingArticle");
async function runExistingRepairPipeline(env, sourcePost, fetchImpl = fetch, hooks = {}) {
  const seoBrief = hooks?.seoBrief || null;
  const rewrittenArticle = await rewriteExistingArticle(env, sourcePost, seoBrief, fetchImpl, hooks);
  const evaluation = await qualityLoop(env, rewrittenArticle, fetchImpl, hooks, {
    initialCriticStage: "existing_post_rewrite_diagnosis",
    retryCriticStage: "existing_post_rewrite_final",
    sourcePost: sourcePost.identity,
    preserve: ["blogId", "bloggerPostId", "permalink"],
    seoBrief,
    repairStrategy: TARGETED_REPAIR
  });
  const common = {
    identity: sourcePost.identity,
    seoBrief,
    rewriteApplied: true,
    rewriteMode: "full_article_same_post_id",
    originalTitle: sourcePost.article?.title || null
  };
  if (evaluation.status === "PASS") {
    return {
      status: "READY_TO_UPDATE_EXISTING",
      article: evaluation.article,
      initialCritic: evaluation.initialCritic,
      finalCritic: evaluation.finalCritic,
      repairApplied: true,
      styleRepairApplied: evaluation.styleRepairApplied,
      repairAttempts: evaluation.repairAttempts,
      repairStrategy: evaluation.repairStrategy,
      repairGuardViolations: evaluation.repairGuardViolations,
      styleLint: evaluation.styleLint,
      ...common
    };
  }
  return reviewResult(evaluation, {
    ...common,
    repairApplied: true
  });
}
__name(runExistingRepairPipeline, "runExistingRepairPipeline");
async function runExistingRepairContinuationPipeline(env, priorResult, fetchImpl = fetch, hooks = {}) {
  const identity = priorResult?.identity;
  if (!identity?.blogId || !identity?.bloggerPostId) throw new Error("REPAIR_CONTINUATION_IDENTITY_MISSING");
  const article = liftBlocksOutOfParagraphs(validateArticle(priorResult?.article));
  const seoBrief = hooks?.seoBrief || priorResult?.seoBrief || null;
  const evaluation = await qualityLoop(env, article, fetchImpl, hooks, {
    initialCriticStage: "existing_post_continued_diagnosis",
    retryCriticStage: "existing_post_continued_final",
    sourcePost: identity,
    preserve: ["blogId", "bloggerPostId", "permalink"],
    seoBrief,
    repairStrategy: CONTINUATION_REWRITE,
    continuationAttempt: Math.max(0, Number(priorResult?.continuationAttempt || 0)) + 1,
    priorIssues: priorResult?.finalCritic?.issues || []
  });
  const continuation = continuationMeta(priorResult, evaluation);
  if (evaluation.status === "PASS") {
    return {
      status: "READY_TO_UPDATE_EXISTING",
      article: evaluation.article,
      initialCritic: evaluation.initialCritic,
      finalCritic: evaluation.finalCritic,
      repairApplied: Boolean(priorResult?.repairApplied || evaluation.repairApplied),
      styleRepairApplied: Boolean(priorResult?.styleRepairApplied || evaluation.styleRepairApplied),
      repairAttempts: evaluation.repairAttempts,
      repairStrategy: evaluation.repairStrategy,
      repairGuardViolations: evaluation.repairGuardViolations,
      styleLint: evaluation.styleLint,
      identity,
      seoBrief,
      ...continuation
    };
  }
  return reviewResult(evaluation, {
    identity,
    seoBrief,
    repairApplied: Boolean(priorResult?.repairApplied || evaluation.repairApplied),
    styleRepairApplied: Boolean(priorResult?.styleRepairApplied || evaluation.styleRepairApplied),
    ...continuation
  });
}
__name(runExistingRepairContinuationPipeline, "runExistingRepairContinuationPipeline");
