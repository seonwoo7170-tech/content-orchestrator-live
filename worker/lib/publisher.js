import { callHub } from './api-hub.js';

function writesEnabled(env) {
  return env.BLOGGER_WRITES_ENABLED === 'true';
}

export function assertExistingIdentity(original, candidate) {
  const originalBlogId = String(original?.blogId || '');
  const originalPostId = String(original?.bloggerPostId || '');
  const candidateBlogId = String(candidate?.blogId || '');
  const candidatePostId = String(candidate?.bloggerPostId || '');
  if (!originalBlogId || !originalPostId) throw new Error('ORIGINAL_BLOGGER_IDENTITY_REQUIRED');
  if (originalBlogId !== candidateBlogId) throw new Error('BLOG_ID_CHANGED_DURING_REPAIR');
  if (originalPostId !== candidatePostId) throw new Error('BLOGGER_POST_ID_CHANGED_DURING_REPAIR');
  return true;
}

export async function updateExistingPost(env, originalIdentity, payload, fetchImpl = fetch) {
  if (!writesEnabled(env)) throw new Error('BLOGGER_WRITES_DISABLED');
  assertExistingIdentity(originalIdentity, payload);
  if (payload.operation && payload.operation !== 'update') throw new Error('EXISTING_REPAIR_MUST_UPDATE');

  return callHub(
    env,
    env.HUB_BLOGGER_POST_PATH || '/api/blogger/post',
    { ...payload, operation: 'update', publishMode: payload.publishMode || 'published' },
    fetchImpl
  );
}

export async function publishNewPost(env, payload, fetchImpl = fetch) {
  if (!writesEnabled(env)) throw new Error('BLOGGER_WRITES_DISABLED');
  if (payload.bloggerPostId) throw new Error('NEW_POST_MUST_NOT_HAVE_EXISTING_POST_ID');
  return callHub(
    env,
    env.HUB_BLOGGER_POST_PATH || '/api/blogger/post',
    { ...payload, operation: 'create' },
    fetchImpl
  );
}
