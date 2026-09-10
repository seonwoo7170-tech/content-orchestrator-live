import { validateArticle, validateCriticResult } from './contracts.js';
import { callHub } from './api-hub.js';
import { lintNaturalWriting } from './natural-writing-linter.js';
import { assertTargetedRepairPreserved, constrainTargetedRepair } from './targeted-repair-guard.js';
import { stripWriterOwnedImages } from './article-image-sanitizer.js';

const DEFAULT_MAX_TARGETED_REPAIRS = 2;
const DEFAULT_MAX_NEW_ARTICLE_CANDIDATES = 2;
const TARGETED_REPAIR = 'targeted_sections_only';
const CONTINUATION_REWRITE = 'targeted_sections_rewrite';
const STRUCTURAL_REPLAN_CODES = new Set([
  'LOW_INFORMATION_GAIN',
  'OUTLINE_REDESIGN_REQUIRED',
  'STRUCTURAL_COMPLETENESS_GAP',
  'ARTICLE_TOO_THIN'
]);

async function emitStage(hooks, stage) {
  if (typeof hooks?.onStage === 'function') await hooks.onStage(stage);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function maxTargetedRepairs(env) {
  return boundedInteger(env?.TARGETED_REPAIR_MAX_ATTEMPTS, DEFAULT_MAX_TARGETED_REPAIRS, 2, 2);
}

function maxNewArticleCandidates(env) {
  return boundedInteger(env?.NEW_ARTICLE_MAX_CANDIDATES, DEFAULT_MAX_NEW_ARTICLE_CANDIDATES, 1, 2);
}

function isRepairGuardError(error) {
  return String(error?.code || error?.message || '').startsWith('TARGETED_REPAIR_');
}

function issueKey(issue) {
  return `${String(issue?.code || '').trim().toUpperCase()}|${String(issue?.location || '').trim().toLowerCase()}`;
}

function structuralReplanRequired(critic) {
  const issues = Array.isArray(critic?.issues) ? critic.issues : [];
  const codes = issues.map((issue) => String(issue?.code || '').trim().toUpperCase()).filter(Boolean);
  if (codes.some((code) => STRUCTURAL_REPLAN_CODES.has(code))) return true;
  return codes.filter((code) => code === 'CORE_INFORMATION_MISSING').length >= 2;
}

function retryReasonForEvaluation(evaluation) {
  if (!evaluation) return null;
  if (evaluation.reviewReason === 'MASTER_REPLAN_REQUIRED') {
    return 'MASTER_REPLAN_REQUIRED: the previous candidate lacked information gain or multiple core decision/action details. Re-plan the outline from the seoBrief before drafting and add concrete decision criteria, exceptions, checkpoints, and practical depth instead of patching the previous structure.';
  }
  return evaluation.reviewReason || null;
}

function escalatedRepairIssues(issues, context = {}) {
  if (context.repairStrategy !== CONTINUATION_REWRITE) return issues;
  const priorKeys = new Set((Array.isArray(context.priorIssues) ? context.priorIssues : []).map(issueKey));
  return (Array.isArray(issues) ? issues : []).map((issue) => {
    const repeated = priorKeys.has(issueKey(issue));
    const escalation = repeated
      ? 'The same defect survived an earlier targeted repair. Replace the entire exact flagged block with fresh concise wording that fully resolves this issue; do not make another cosmetic or sentence-level tweak.'
      : 'This is a continuation after earlier targeted repairs were exhausted. Rewrite the entire exact flagged block as needed to satisfy this issue while preserving its meaning.';
    return {
      ...issue,
      repairInstruction: `${String(issue?.repairInstruction || '').trim()} ${escalation}`.trim()
    };
  });
}

function styleLintSummary(initialLint, history) {
  const latest = history.length ? history[history.length - 1].lint : initialLint;
  const preCriticStyle = history.find((item) => item.phase === 'pre_critic_style_repair')?.lint ?? initialLint;
  const afterCriticRepair = history.find((item) => item.phase === 'after_critic_repair')?.lint ?? null;
  const afterPostRepairStyleRepair = [...history].reverse().find((item) => item.phase === 'post_critic_style_repair')?.lint ?? null;
  return {
    beforeCritic: initialLint,
    afterStyleRepair: preCriticStyle,
    afterCriticRepair,
    afterPostRepairStyleRepair,
    final: latest,
    history
  };
}

async function criticCheck(env, article, fetchImpl, hooks, context, criticCheckCount) {
  await emitStage(hooks, criticCheckCount === 0 ? 'critic_review' : 'final_critic');
  return validateCriticResult(await callHub(
    env,
    env.HUB_CRITIC_PATH || '/api/hub/ai/critic',
    {
      article,
      stage: criticCheckCount === 0 ? context.initialCriticStage : context.retryCriticStage,
      ...(context.sourcePost ? { sourcePost: context.sourcePost } : {}),
      ...(context.seoBrief ? { seoBrief: context.seoBrief } : {})
    },
    fetchImpl
  ));
}

async function qualityLoop(env, initialArticle, fetchImpl, hooks, context) {
  const maxRepairs = maxTargetedRepairs(env);
  const repairStrategy = context.repairStrategy || TARGETED_REPAIR;
  let article = initialArticle;
  const initialLint = lintNaturalWriting(article);
  let currentLint = initialLint;
  const lintHistory = [{ phase: 'initial', lint: initialLint }];
  let repairAttempts = 0;
  let repairApplied = false;
  let styleRepairApplied = false;
  let criticCheckCount = 0;
  let initialCritic = null;
  let finalCritic = null;
  const repairGuardViolations = [];

  while (true) {
    let issueSource;
    let issues;

    if (currentLint.status === 'BLOCK') {
      issueSource = 'linter';
      issues = currentLint.blockingIssues;
    } else {
      const critic = await criticCheck(env, article, fetchImpl, hooks, context, criticCheckCount);
      if (!initialCritic) initialCritic = critic;
      finalCritic = critic;
      criticCheckCount += 1;
      if (critic.status === 'PASS') {
        return {
          status: 'PASS',
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
        return {
          status: 'FAIL',
          article,
          initialCritic,
          finalCritic,
          repairApplied,
          styleRepairApplied,
          repairAttempts,
          repairStrategy,
          repairGuardViolations,
          styleLint: styleLintSummary(initialLint, lintHistory),
          reviewReason: 'MASTER_REPLAN_REQUIRED'
        };
      }
      issueSource = 'critic';
      issues = critic.issues;
    }

    if (repairAttempts >= maxRepairs) {
      return {
        status: 'FAIL',
        article,
        initialCritic,
        finalCritic,
        repairApplied,
        styleRepairApplied,
        repairAttempts,
        repairStrategy,
        repairGuardViolations,
        styleLint: styleLintSummary(initialLint, lintHistory),
        reviewReason: issueSource === 'linter'
          ? 'NATURAL_WRITING_LINT_BLOCKED_AFTER_MAX_TARGETED_REPAIRS'
          : 'CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS'
      };
    }

    let repairSucceeded = false;
    while (!repairSucceeded && repairAttempts < maxRepairs) {
      await emitStage(hooks, issueSource === 'linter' ? 'style_repairing' : 'repairing');
      repairAttempts += 1;
      const beforeRepair = article;
      const repairIssues = escalatedRepairIssues(issues, context);

      try {
        const repair = await callHub(
          env,
          env.HUB_REPAIR_PATH || '/api/hub/ai/repair',
          {
            article: beforeRepair,
            issues: repairIssues,
            strategy: repairStrategy,
            continuationAttempt: Number(context.continuationAttempt || 0),
            repairAttempt: repairAttempts,
            maxRepairAttempts: maxRepairs,
            ...(context.sourcePost ? { sourcePost: context.sourcePost } : {}),
            ...(context.preserve ? { preserve: context.preserve } : {}),
            ...(context.seoBrief ? { seoBrief: context.seoBrief } : {})
          },
          fetchImpl
        );
        const candidateArticle = validateArticle(repair.article ?? repair);
        const repairedArticle = validateArticle(constrainTargetedRepair(beforeRepair, candidateArticle, repairIssues));
        assertTargetedRepairPreserved(beforeRepair, repairedArticle, repairIssues);
        article = repairedArticle;
        repairApplied = true;
        if (issueSource === 'linter') styleRepairApplied = true;
        repairSucceeded = true;
      } catch (error) {
        if (!isRepairGuardError(error)) throw error;
        repairGuardViolations.push({
          attempt: repairAttempts,
          code: String(error.code || error.message),
          meta: error.meta ?? null
        });
        if (repairAttempts >= maxRepairs) {
          return {
            status: 'FAIL',
            article,
            initialCritic,
            finalCritic,
            repairApplied,
            styleRepairApplied,
            repairAttempts,
            repairStrategy,
            repairGuardViolations,
            styleLint: styleLintSummary(initialLint, lintHistory),
            reviewReason: 'TARGETED_REPAIR_SCOPE_VIOLATION'
          };
        }
      }
    }

    if (!repairSucceeded) {
      return {
        status: 'FAIL',
        article,
        initialCritic,
        finalCritic,
        repairApplied,
        styleRepairApplied,
        repairAttempts,
        repairStrategy,
        repairGuardViolations,
        styleLint: styleLintSummary(initialLint, lintHistory),
        reviewReason: 'TARGETED_REPAIR_EXHAUSTED'
      };
    }

    currentLint = lintNaturalWriting(article);
    const phase = issueSource === 'critic'
      ? 'after_critic_repair'
      : (criticCheckCount > 0 ? 'post_critic_style_repair' : 'pre_critic_style_repair');
    lintHistory.push({ phase, lint: currentLint });
  }
}

function readyResult(evaluation, extra = {}) {
  return {
    status: 'READY',
    article: evaluation.article,
    initialCritic: evaluation.initialCritic,
    finalCritic: evaluation.finalCritic,
    repairApplied: evaluation.repairApplied,
    styleRepairApplied: evaluation.styleRepairApplied,
    repairAttempts: evaluation.repairAttempts,
    repairStrategy: evaluation.repairStrategy,
    repairGuardViolations: evaluation.repairGuardViolations,
    styleLint: evaluation.styleLint,
    ...extra
  };
}

function reviewResult(evaluation, extra = {}) {
  return {
    status: 'NEEDS_REVIEW',
    article: evaluation.article,
    initialCritic: evaluation.initialCritic,
    finalCritic: evaluation.finalCritic,
    repairApplied: evaluation.repairApplied,
    styleRepairApplied: evaluation.styleRepairApplied,
    repairAttempts: evaluation.repairAttempts,
    repairStrategy: evaluation.repairStrategy,
    repairGuardViolations: evaluation.repairGuardViolations,
    styleLint: evaluation.styleLint,
    reviewReason: evaluation.reviewReason || 'TARGETED_REPAIR_EXHAUSTED',
    ...extra
  };
}

function continuationMeta(priorResult, evaluation) {
  const continuationAttempt = Math.max(0, Number(priorResult?.continuationAttempt || 0)) + 1;
  const previousHistory = Array.isArray(priorResult?.continuationHistory)
    ? priorResult.continuationHistory
    : [];
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
    priorResult?.totalRepairAttempts
      ?? priorResult?.repairAttempts
      ?? 0
  );
  return {
    continuationAttempt,
    continuationHistory,
    totalRepairAttempts: previousTotal + Number(evaluation.repairAttempts || 0)
  };
}

export async function runNewArticlePipeline(env, request, fetchImpl = fetch, hooks = {}) {
  const maxCandidates = maxNewArticleCandidates(env);
  const candidateHistory = [];
  let lastEvaluation = null;
  const seoBrief = request?.seoBrief || null;

  for (let candidateAttempt = 1; candidateAttempt <= maxCandidates; candidateAttempt += 1) {
    if (candidateAttempt > 1) await emitStage(hooks, 'candidate_regenerating');

    const writer = await callHub(
      env,
      env.HUB_WRITER_PATH || '/api/hub/ai/writer',
      {
        ...request,
        candidateAttempt,
        ...(lastEvaluation ? { retryReason: retryReasonForEvaluation(lastEvaluation) } : {})
      },
      fetchImpl
    );
    const writtenArticle = stripWriterOwnedImages(validateArticle(writer.article ?? writer));

    const evaluation = await qualityLoop(env, writtenArticle, fetchImpl, hooks, {
      initialCriticStage: candidateAttempt === 1 ? 'initial' : 'regenerated_initial',
      retryCriticStage: candidateAttempt === 1 ? 'final' : 'regenerated_final',
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

    if (evaluation.status === 'PASS') {
      return readyResult(evaluation, {
        candidateAttempt,
        candidateRegenerated: candidateAttempt > 1,
        candidateHistory,
        seoBrief
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

export async function runNewArticleContinuationPipeline(env, priorResult, fetchImpl = fetch, hooks = {}) {
  const article = validateArticle(priorResult?.article);
  const seoBrief = hooks?.seoBrief || priorResult?.seoBrief || null;
  const evaluation = await qualityLoop(env, article, fetchImpl, hooks, {
    initialCriticStage: 'continued_initial',
    retryCriticStage: 'continued_final',
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

  return evaluation.status === 'PASS'
    ? readyResult(evaluation, common)
    : reviewResult(evaluation, common);
}

async function rewriteExistingArticle(env, sourcePost, seoBrief, fetchImpl, hooks) {
  const sourceArticle = validateArticle(sourcePost?.article);
  const identity = sourcePost?.identity || {};
  if (!identity?.blogId || !identity?.bloggerPostId) throw new Error('REPAIR_SOURCE_IDENTITY_MISSING');
  await emitStage(hooks, 'writing');
  const rewriteSource = {
    title: sourceArticle.title,
    topic: sourceArticle.topic,
    searchDescription: sourceArticle.searchDescription,
    labels: sourceArticle.labels,
    language: sourceArticle.language
  };
  const writer = await callHub(
    env,
    env.HUB_WRITER_PATH || '/api/hub/ai/writer',
    {
      blogId: String(identity.blogId),
      topic: String(sourceArticle.topic || sourceArticle.title),
      language: sourceArticle.language,
      rewriteExisting: true,
      rewriteSource,
      ...(seoBrief ? { seoBrief } : {})
    },
    fetchImpl
  );
  return validateArticle(writer.article ?? writer);
}

export async function runExistingRepairPipeline(env, sourcePost, fetchImpl = fetch, hooks = {}) {
  const seoBrief = hooks?.seoBrief || null;
  const rewrittenArticle = await rewriteExistingArticle(env, sourcePost, seoBrief, fetchImpl, hooks);
  const evaluation = await qualityLoop(env, rewrittenArticle, fetchImpl, hooks, {
    initialCriticStage: 'existing_post_rewrite_diagnosis',
    retryCriticStage: 'existing_post_rewrite_final',
    sourcePost: sourcePost.identity,
    preserve: ['blogId', 'bloggerPostId', 'permalink'],
    seoBrief,
    repairStrategy: TARGETED_REPAIR
  });

  const common = {
    identity: sourcePost.identity,
    seoBrief,
    rewriteApplied: true,
    rewriteMode: 'full_article_same_post_id',
    originalTitle: sourcePost.article?.title || null
  };

  if (evaluation.status === 'PASS') {
    return {
      status: 'READY_TO_UPDATE_EXISTING',
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

export async function runExistingRepairContinuationPipeline(env, priorResult, fetchImpl = fetch, hooks = {}) {
  const identity = priorResult?.identity;
  if (!identity?.blogId || !identity?.bloggerPostId) throw new Error('REPAIR_CONTINUATION_IDENTITY_MISSING');
  const article = validateArticle(priorResult?.article);
  const seoBrief = hooks?.seoBrief || priorResult?.seoBrief || null;
  const evaluation = await qualityLoop(env, article, fetchImpl, hooks, {
    initialCriticStage: 'existing_post_continued_diagnosis',
    retryCriticStage: 'existing_post_continued_final',
    sourcePost: identity,
    preserve: ['blogId', 'bloggerPostId', 'permalink'],
    seoBrief,
    repairStrategy: CONTINUATION_REWRITE,
    continuationAttempt: Math.max(0, Number(priorResult?.continuationAttempt || 0)) + 1,
    priorIssues: priorResult?.finalCritic?.issues || []
  });
  const continuation = continuationMeta(priorResult, evaluation);

  if (evaluation.status === 'PASS') {
    return {
      status: 'READY_TO_UPDATE_EXISTING',
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
