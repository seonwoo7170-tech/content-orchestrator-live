function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  throw error;
}

function allowedBlogIds(env) {
  return new Set(String(env.BLOGGER_WRITE_ALLOWED_BLOG_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function assertManagedAllowlist(env, input) {
  const allowlist = allowedBlogIds(env);
  const requestBlogId = String(input?.blogId || '').trim();
  if (!requestBlogId || !allowlist.has(requestBlogId)) forbidden('BLOGGER_WRITE_TARGET_NOT_ALLOWED');

  const operation = String(input?.operation || 'create');
  const publishMode = String(input?.publishMode || 'draft').toLowerCase();
  if (!['create', 'update'].includes(operation)) forbidden('BLOGGER_WRITE_OPERATION_NOT_ALLOWED');
  if (operation === 'create' && !['draft', 'published', 'scheduled'].includes(publishMode)) {
    forbidden('BLOGGER_WRITE_PUBLISH_MODE_NOT_ALLOWED');
  }
  if (operation === 'update' && !String(input?.bloggerPostId || '').trim()) {
    forbidden('BLOGGER_WRITE_EXISTING_POST_ID_REQUIRED');
  }
  return true;
}

export function assertBloggerWriteAllowed(env, input) {
  if (env.BLOGGER_WRITES_ENABLED !== 'true') forbidden('BLOGGER_WRITES_DISABLED');

  const mode = String(env.BLOGGER_WRITE_MODE || 'disabled');
  if (mode === 'normal') return true;
  if (mode === 'managed_allowlist') return assertManagedAllowlist(env, input);

  if (mode === 'phase1_single_draft') {
    const targetBlogId = String(env.PHASE1_DRAFT_BLOG_ID || '').trim();
    const requestBlogId = String(input?.blogId || '').trim();
    const operation = String(input?.operation || 'create');
    const publishMode = String(input?.publishMode || 'draft');

    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden('PHASE1_DRAFT_TARGET_MISMATCH');
    if (input?.phase1Test !== true) forbidden('PHASE1_DRAFT_INTENT_REQUIRED');
    if (operation !== 'create') forbidden('PHASE1_DRAFT_CREATE_ONLY');
    if (publishMode === 'published') forbidden('PHASE1_DRAFT_PUBLISH_FORBIDDEN');
    return true;
  }

  if (mode === 'phase2_single_publish') {
    const targetBlogId = String(env.PHASE2_SINGLE_PUBLISH_BLOG_ID || '').trim();
    const requestBlogId = String(input?.blogId || '').trim();
    const operation = String(input?.operation || 'create');
    const publishMode = String(input?.publishMode || 'draft');

    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden('PHASE2_PUBLISH_TARGET_MISMATCH');
    if (input?.phase2SinglePublish !== true) forbidden('PHASE2_PUBLISH_INTENT_REQUIRED');
    if (operation !== 'create') forbidden('PHASE2_PUBLISH_CREATE_ONLY');
    if (publishMode !== 'published') forbidden('PHASE2_PUBLISH_MODE_REQUIRED');
    if (input?.bloggerPostId) forbidden('PHASE2_PUBLISH_NEW_POST_ONLY');
    return true;
  }

  if (mode === 'phase2_single_repair') {
    const targetBlogId = String(env.PHASE2_SINGLE_REPAIR_BLOG_ID || '').trim();
    const targetPostId = String(env.PHASE2_SINGLE_REPAIR_POST_ID || '').trim();
    const requestBlogId = String(input?.blogId || '').trim();
    const requestPostId = String(input?.bloggerPostId || '').trim();
    const operation = String(input?.operation || 'create');

    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden('PHASE2_REPAIR_TARGET_BLOG_MISMATCH');
    if (!targetPostId || requestPostId !== targetPostId) forbidden('PHASE2_REPAIR_TARGET_POST_MISMATCH');
    if (input?.phase2SingleRepair !== true) forbidden('PHASE2_REPAIR_INTENT_REQUIRED');
    if (operation !== 'update') forbidden('PHASE2_REPAIR_UPDATE_ONLY');
    return true;
  }

  forbidden('BLOGGER_WRITE_MODE_DISABLED');
}
