import { callHub } from './api-hub.js';
import { validateArticle } from './contracts.js';
import {
  runExistingRepairContinuationPipeline,
  runExistingRepairPipeline,
  runNewArticleContinuationPipeline,
  runNewArticlePipeline
} from './pipeline.js';
import { assertExistingIdentity } from './publisher.js';
import { buildSeoBrief } from './seo-brief.js';
import { strategyLinksForTopic } from './content-strategy.js';

const REVIEW_CONTINUE_CODE = 'CRITIC_REVIEW_CONTINUE';
const EXISTING_REWRITE_MODE = 'full_article_same_post_id';

async function advisory(call, fallback = null) {
  try { return await call(); } catch { return fallback; }
}

async function seoBriefFor(env, input = {}) {
  const strategyLinks = await advisory(
    () => strategyLinksForTopic(env, String(input.blogId || ''), String(input.topic || ''), 5),
    []
  );
  return advisory(() => buildSeoBrief(env, { ...input, strategyLinks }), null);
}

function isReviewContinuation(job) {
  return job?.recoveryCode === REVIEW_CONTINUE_CODE && Boolean(job?.resumeResult?.article);
}

function isExistingRewriteContinuation(job) {
  return job?.mode === 'repair_existing'
    && isReviewContinuation(job)
    && job?.resumeResult?.rewriteMode === EXISTING_REWRITE_MODE;
}

export async function fetchExistingBloggerPost(env, identity, fetchImpl = fetch) {
  const blogId = String(identity?.blogId || '').trim();
  const bloggerPostId = String(identity?.bloggerPostId || '').trim();
  const targetUrl = String(identity?.targetUrl || '').trim();
  if (!blogId) throw new Error('BLOG_ID_REQUIRED');
  if (!bloggerPostId) throw new Error('BLOGGER_POST_ID_REQUIRED');

  const data = await callHub(
    env,
    env.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
    {
      blogId,
      bloggerPostId,
      ...(targetUrl ? { targetUrl } : {})
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

export async function executeJob(env, job, fetchImpl = fetch, hooks = {}) {
  if (!job || typeof job !== 'object') throw new Error('JOB_REQUIRED');

  if (job.mode === 'new_article') {
    const request = {
      blogId: String(job.blogId || ''),
      topic: String(job.topic || ''),
      language: job.language || 'ko',
      topicCandidateId: Number(job.topicCandidateId || 0) || null,
      topicSource: job.topicSource || null
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

  if (job.mode === 'repair_existing') {
    // Only continue Critic/Repair when the saved candidate was already produced by
    // the new full-rewrite policy. Legacy CRITIC_REVIEW_CONTINUE results came from
    // patch-first repair and are intentionally discarded in favor of refetching the
    // same Blogger post and creating a fresh full rewrite under the current policy.
    if (isExistingRewriteContinuation(job)) {
      const prior = job.resumeResult;
      assertExistingIdentity(
        { blogId: String(job.blogId || ''), bloggerPostId: String(job.bloggerPostId || '') },
        prior.identity
      );
      const seoBrief = prior.seoBrief || await seoBriefFor(env, {
        blogId: String(job.blogId || ''),
        topic: String(prior.article?.topic || prior.article?.title || job.topic || ''),
        language: prior.article?.language || 'ko'
      });
      return runExistingRepairContinuationPipeline(
        env,
        prior,
        fetchImpl,
        { ...hooks, seoBrief }
      );
    }

    const sourcePost = await fetchExistingBloggerPost(env, {
      blogId: job.blogId,
      bloggerPostId: job.bloggerPostId,
      targetUrl: job.targetUrl
    }, fetchImpl);
    const seoBrief = await seoBriefFor(env, {
      blogId: String(job.blogId || ''),
      topic: String(sourcePost.article.topic || sourcePost.article.title || ''),
      language: sourcePost.article.language || 'ko'
    });
    return runExistingRepairPipeline(env, sourcePost, fetchImpl, { ...hooks, seoBrief });
  }

  throw new Error('JOB_MODE_INVALID');
}