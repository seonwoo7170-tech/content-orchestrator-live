// worker/lib/stored-job-executor.js
var REVIEW_CONTINUE_CODE2 = "CRITIC_REVIEW_CONTINUE";
var EXISTING_REWRITE_MODE3 = "full_article_same_post_id";
function parseStoredResult(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("STORED_JOB_RESULT_INVALID");
  }
}
__name(parseStoredResult, "parseStoredResult");
function normalizeStoredJob(row) {
  if (!row || typeof row !== "object") throw new Error("STORED_JOB_REQUIRED");
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    throw new Error("STORED_JOB_PAYLOAD_INVALID");
  }
  return {
    ...payload,
    id: Number(row.id),
    mode: row.mode,
    blogId: row.blog_id ?? payload.blogId ?? null,
    bloggerPostId: row.blogger_post_id ?? payload.bloggerPostId ?? null,
    targetUrl: row.target_url ?? payload.targetUrl ?? null,
    topic: row.topic ?? payload.topic ?? null,
    status: row.status,
    recoveryCode: String(row.last_error_code || ""),
    resumeResult: parseStoredResult(row.result_json)
  };
}
__name(normalizeStoredJob, "normalizeStoredJob");
function normalizePipelineStage(stage) {
  if (stage === "style_repairing") return "repairing";
  if (stage === "candidate_regenerating") return "writing";
  return stage;
}
__name(normalizePipelineStage, "normalizePipelineStage");
function isReviewContinuation2(job) {
  return job?.recoveryCode === REVIEW_CONTINUE_CODE2 && Boolean(job?.resumeResult?.article);
}
__name(isReviewContinuation2, "isReviewContinuation");
function resumesAtCritic(job) {
  if (!isReviewContinuation2(job)) return false;
  if (job?.mode !== "repair_existing") return true;
  return job?.resumeResult?.rewriteMode === EXISTING_REWRITE_MODE3;
}
__name(resumesAtCritic, "resumesAtCritic");
function stageEvent(stage, counters, maxRepairs, extra) {
  const extraMeta = extra && typeof extra === "object" ? extra : null;
  if (stage === "writing") return { eventType: "writer", stage, message: "Writer \uC2DC\uC791", level: "info" };
  if (stage === "candidate_regenerating") return { eventType: "writer_retry", stage: "writing", message: "Writer \uD6C4\uBCF4 \uC7AC\uC791\uC131 \uC2DC\uC791", level: "warn" };
  if (stage === "critic_review") {
    counters.critic += 1;
    return { eventType: "critic", stage, message: counters.critic === 1 ? "\uB534\uC9C0 1\uCC28 \uAC80\uC0AC \uC2DC\uC791" : `\uB534\uC9C0 \uC7AC\uAC80\uC0AC ${counters.critic}\uD68C\uCC28 \uC2DC\uC791`, level: "info", meta: { criticCheck: counters.critic, ...extraMeta } };
  }
  if (stage === "final_critic") {
    counters.critic += 1;
    return { eventType: "critic", stage, message: `\uCD5C\uC885 \uB534\uC9C0 \uAC80\uC0AC \uC2DC\uC791 (${counters.critic}\uD68C\uCC28)`, level: "info", meta: { criticCheck: counters.critic, ...extraMeta } };
  }
  if (stage === "repairing" || stage === "style_repairing") {
    counters.repair += 1;
    const label = stage === "style_repairing" ? "\uBB38\uCCB4 \uBD80\uBD84\uBCF4\uC644" : "\uBD80\uBD84\uBCF4\uC644";
    return {
      eventType: "repair",
      stage: "repairing",
      message: `${label} ${counters.repair}/${maxRepairs} \uC2DC\uC791`,
      level: "warn",
      meta: { repairAttempt: counters.repair, maxRepairAttempts: maxRepairs, ...extraMeta }
    };
  }
  return { eventType: "stage", stage: normalizePipelineStage(stage), message: `${stage} \uB2E8\uACC4 \uC2DC\uC791`, level: "info" };
}
__name(stageEvent, "stageEvent");
function resultEvent(result, counters) {
  const critic = result?.finalCritic || result?.initialCritic || null;
  const score = critic?.score ?? critic?.totalScore ?? null;
  const status = String(critic?.status || "");
  const provider = critic?.provider ?? null;
  const issueCount = Array.isArray(critic?.issues) ? critic.issues.length : 0;
  const scoreText = score === null ? "" : ` \xB7 ${score}\uC810`;
  if (result?.status === "NEEDS_REVIEW") {
    return {
      eventType: "quality_result",
      stage: "final_critic",
      level: "warn",
      message: `\uCD5C\uC885 \uB534\uC9C0 ${status || "FAIL"}${scoreText} \xB7 \uD655\uC778 \uD544\uC694`,
      meta: { status, score, provider, issueCount, repairAttempts: counters.repair }
    };
  }
  return {
    eventType: "quality_result",
    stage: "final_critic",
    level: "success",
    message: `\uCD5C\uC885 \uB534\uC9C0 ${status || "PASS"}${scoreText} \xB7 \uD488\uC9C8\uAC80\uC0AC \uC644\uB8CC`,
    meta: { status, score, provider, issueCount, repairAttempts: counters.repair }
  };
}
__name(resultEvent, "resultEvent");
async function processStoredJob(env, row, options = {}) {
  const job = normalizeStoredJob(row);
  if (job.status !== "queued") throw new Error(`JOB_NOT_RUNNABLE:${job.status}`);
  const fetchImpl = options.fetchImpl || fetch;
  const saveState = typeof options.saveState === "function" ? options.saveState : async () => {
  };
  const initial = resumesAtCritic(job) ? "critic_review" : "writing";
  const maxRepairs = Math.min(3, Math.max(2, Number.parseInt(String(env?.TARGETED_REPAIR_MAX_ATTEMPTS ?? 2), 10) || 2));
  const counters = { repair: 0, critic: 0 };
  let current = "queued";
  if (env?.ORCHESTRATOR_DB) {
    const claimFn = options.claimExecutionFn || claimStoredJobExecution;
    const claimed = await claimFn(env, job.id, initial);
    if (!claimed) throw Object.assign(new Error("JOB_EXECUTION_ALREADY_CLAIMED"), { status: 409 });
    current = initial;
    await appendJobEvent(env, job.id, {
      eventType: "job_start",
      stage: initial,
      level: "info",
      message: `#${job.id} \uC791\uC5C5 \uC2DC\uC791 \xB7 ${job.mode === "repair_existing" ? "\uAE30\uC874\uAE00 \uB9AC\uD398\uC5B4" : "\uC2E0\uADDC \uAE00"}`,
      meta: { mode: job.mode, maxRepairAttempts: maxRepairs }
    });
  }
  const transition = /* @__PURE__ */ __name(async (next, patch = {}) => {
    const normalizedNext = normalizePipelineStage(next);
    if (normalizedNext === current) return;
    assertTransition(current, normalizedNext);
    current = normalizedNext;
    await saveState(normalizedNext, patch);
  }, "transition");
  try {
    if (current === "queued") await transition(initial);
    const result = await executeJob(env, job, fetchImpl, {
      onStage: /* @__PURE__ */ __name(async (stage, meta2) => {
        await appendJobEvent(env, job.id, stageEvent(stage, counters, maxRepairs, meta2));
        return transition(stage);
      }, "onStage")
    });
    await appendJobEvent(env, job.id, resultEvent(result, counters));
    if (result.status === "NO_CHANGE_NEEDED") {
      await transition("ready");
      await transition("completed", { result });
      await appendJobEvent(env, job.id, { eventType: "done", stage: "completed", level: "success", message: `#${job.id} \uC644\uB8CC \xB7 \uBCC0\uACBD \uD544\uC694 \uC5C6\uC74C` });
      return { state: current, result };
    }
    if (result.status === "READY" || result.status === "READY_TO_UPDATE_EXISTING") {
      await transition("ready", { result });
      await appendJobEvent(env, job.id, {
        eventType: "article_ready",
        stage: "ready",
        level: "success",
        message: `\uBCF8\uBB38 \uC900\uBE44 \uC644\uB8CC \xB7 \uC774\uBBF8\uC9C0 \uB2E8\uACC4 \uB300\uAE30`,
        meta: { repairAttempts: counters.repair, maxRepairAttempts: maxRepairs }
      });
      return { state: current, result };
    }
    if (result.status === "NEEDS_REVIEW") {
      await transition("needs_review", { result });
      return { state: current, result };
    }
    throw new Error(`PIPELINE_RESULT_INVALID:${result.status}`);
  } catch (error) {
    if (current !== "failed") {
      const errorCode = safeFailureCode(error);
      const errorDetail = safeErrorDetail(error?.providerHint);
      const errorForDisplay = errorDetail ? `${errorCode}: ${errorDetail}` : errorCode;
      try {
        await transition("failed", { error: errorForDisplay });
      } catch {
      }
      try {
        await appendJobEvent(env, job.id, {
          eventType: "error",
          stage: current,
          level: "error",
          message: `\uC791\uC5C5 \uC624\uB958 \xB7 ${errorForDisplay}`,
          meta: { errorCode, errorDetail }
        });
      } catch {
      }
    }
    throw error;
  }
}
__name(processStoredJob, "processStoredJob");
