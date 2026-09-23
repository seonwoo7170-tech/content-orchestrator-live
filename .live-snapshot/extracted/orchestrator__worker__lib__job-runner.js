// worker/lib/job-runner.js
var REVIEW_CONTINUE_CODE = "CRITIC_REVIEW_CONTINUE";
var EXISTING_REWRITE_MODE2 = "full_article_same_post_id";
async function advisory(call, fallback = null) {
  try {
    return await call();
  } catch {
    return fallback;
  }
}
__name(advisory, "advisory");
async function seoBriefFor(env, input = {}) {
  const strategyLinks = await advisory(
    () => strategyLinksForTopic(env, String(input.blogId || ""), String(input.topic || ""), 5),
    []
  );
  return advisory(() => buildSeoBrief(env, { ...input, strategyLinks }), null);
}
__name(seoBriefFor, "seoBriefFor");
function isReviewContinuation(job) {
  return job?.recoveryCode === REVIEW_CONTINUE_CODE && Boolean(job?.resumeResult?.article);
}
__name(isReviewContinuation, "isReviewContinuation");
function isExistingRewriteContinuation(job) {
  return job?.mode === "repair_existing" && isReviewContinuation(job) && job?.resumeResult?.rewriteMode === EXISTING_REWRITE_MODE2;
}
__name(isExistingRewriteContinuation, "isExistingRewriteContinuation");
async function fetchExistingBloggerPost(env, identity, fetchImpl = fetch) {
  const blogId = String(identity?.blogId || "").trim();
  const bloggerPostId = String(identity?.bloggerPostId || "").trim();
  const targetUrl = String(identity?.targetUrl || "").trim();
  if (!blogId) throw new Error("BLOG_ID_REQUIRED");
  if (!bloggerPostId) throw new Error("BLOGGER_POST_ID_REQUIRED");
  const data = await callHub(
    env,
    env.HUB_BLOGGER_GET_PATH || "/api/blogger/post/get",
    {
      blogId,
      bloggerPostId,
      ...targetUrl ? { targetUrl } : {}
    },
    fetchImpl
  );
  const sourceIdentity = {
    blogId: String(data?.blogId ?? data?.identity?.blogId ?? blogId),
    bloggerPostId: String(data?.bloggerPostId ?? data?.identity?.bloggerPostId ?? bloggerPostId),
    permalink: data?.permalink ?? data?.identity?.permalink ?? null
  };
  assertExistingIdentity({ blogId, bloggerPostId }, sourceIdentity);
  return {
    identity: sourceIdentity,
    article: validateArticle(data?.article ?? data)
  };
}
__name(fetchExistingBloggerPost, "fetchExistingBloggerPost");
async function executeJob(env, job, fetchImpl = fetch, hooks = {}) {
  if (!job || typeof job !== "object") throw new Error("JOB_REQUIRED");
  if (job.mode === "new_article") {
    const request = {
      blogId: String(job.blogId || ""),
      topic: String(job.topic || ""),
      language: job.language || "ko",
      topicCandidateId: Number(job.topicCandidateId || 0) || null,
      topicSource: job.topicSource || null,
      ...job.tourApiContentId ? { tourApiContentId: String(job.tourApiContentId) } : {}
    };
    const seoBrief = job.resumeResult?.seoBrief || await seoBriefFor(env, request);
    if (isReviewContinuation(job)) {
      return runNewArticleContinuationPipeline(
        env,
        job.resumeResult,
        fetchImpl,
        { ...hooks, seoBrief }
      );
    }
    return runNewArticlePipeline(env, { ...request, seoBrief }, fetchImpl, hooks);
  }
  if (job.mode === "repair_existing") {
    if (isExistingRewriteContinuation(job)) {
      const prior = job.resumeResult;
      assertExistingIdentity(
        { blogId: String(job.blogId || ""), bloggerPostId: String(job.bloggerPostId || "") },
        prior.identity
      );
      const seoBrief2 = prior.seoBrief || await seoBriefFor(env, {
        blogId: String(job.blogId || ""),
        topic: String(prior.article?.topic || prior.article?.title || job.topic || ""),
        language: prior.article?.language || "ko"
      });
      return runExistingRepairContinuationPipeline(
        env,
        prior,
        fetchImpl,
        { ...hooks, seoBrief: seoBrief2 }
      );
    }
    const sourcePost = await fetchExistingBloggerPost(env, {
      blogId: job.blogId,
      bloggerPostId: job.bloggerPostId,
      targetUrl: job.targetUrl
    }, fetchImpl);
    const seoBrief = await seoBriefFor(env, {
      blogId: String(job.blogId || ""),
      topic: String(sourcePost.article.topic || sourcePost.article.title || ""),
      language: sourcePost.article.language || "ko"
    });
    return runExistingRepairPipeline(env, sourcePost, fetchImpl, { ...hooks, seoBrief });
  }
  throw new Error("JOB_MODE_INVALID");
}
__name(executeJob, "executeJob");
