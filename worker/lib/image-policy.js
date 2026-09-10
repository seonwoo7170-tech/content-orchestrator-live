import { buildImagePlan } from './image-plan.js';

function bodyTarget(value) {
  const number = Number(value ?? 2);
  if (!Number.isInteger(number) || number < 0) return 2;
  return Math.min(3, number);
}

export function countArticleImages(articleOrHtml) {
  const html = typeof articleOrHtml === 'string'
    ? articleOrHtml
    : String(articleOrHtml?.html || '');
  return (html.match(/<img\b[^>]*>/gi) || []).length;
}

export function resolveImagePolicy(mode, article, settings = {}) {
  const normalizedMode = String(mode || 'new_article');
  const enabled = settings?.imagesEnabled !== false;
  const bodyImageCount = bodyTarget(settings?.bodyImageCount);
  const targetTotal = enabled ? 1 + bodyImageCount : 0;
  const existingCount = countArticleImages(article);

  if (!enabled) {
    return {
      enabled: false,
      mode: normalizedMode,
      targetTotal: 0,
      existingCount,
      generatedCount: 0,
      needsThumbnail: false,
      bodyNeeded: 0,
      deficit: 0
    };
  }

  const deficit = Math.max(0, targetTotal - existingCount);
  const needsThumbnail = existingCount === 0 && deficit > 0;
  const bodyNeeded = Math.max(0, deficit - (needsThumbnail ? 1 : 0));

  return {
    enabled: true,
    mode: normalizedMode,
    targetTotal,
    existingCount,
    generatedCount: deficit,
    needsThumbnail,
    bodyNeeded,
    deficit
  };
}

export function buildSupplementalImagePlan(mode, article, settings = {}) {
  const policy = resolveImagePolicy(mode, article, settings);
  if (!policy.enabled || policy.generatedCount === 0) {
    return { ...policy, images: [] };
  }

  const full = buildImagePlan(article, { bodyCount: policy.bodyNeeded });
  const images = [];
  if (policy.needsThumbnail) images.push(full.images[0]);
  images.push(...full.images.filter((image) => image.role === 'body').slice(0, policy.bodyNeeded));
  return { ...policy, images };
}

export function validateImagePolicy(mode, article, settings = {}) {
  const policy = resolveImagePolicy(mode, article, settings);
  if (!policy.enabled) return { ok: true, policy };
  const currentCount = countArticleImages(article);
  return {
    ok: currentCount >= policy.targetTotal,
    currentCount,
    missing: Math.max(0, policy.targetTotal - currentCount),
    policy
  };
}
