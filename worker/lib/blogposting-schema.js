function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

export function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function imageUrls(images = []) {
  return [...new Set((Array.isArray(images) ? images : [])
    .map((row) => canonicalHttpUrl(row?.url || row?.public_url || row))
    .filter(Boolean))].slice(0, 8);
}

export function buildBlogPostingSchema(input = {}) {
  const article = input.article || {};
  const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);
  if (!canonicalUrl) throw new Error('BLOGPOSTING_CANONICAL_URL_REQUIRED');
  const headline = clean(article.title, 300);
  const description = clean(article.searchDescription, 500);
  const language = clean(article.language, 20);
  if (!headline) throw new Error('BLOGPOSTING_HEADLINE_REQUIRED');
  if (!description) throw new Error('BLOGPOSTING_DESCRIPTION_REQUIRED');
  if (!language) throw new Error('BLOGPOSTING_LANGUAGE_REQUIRED');

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline,
    description,
    inLanguage: language,
    url: canonicalUrl,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl
    }
  };

  const images = imageUrls(input.images);
  if (images.length) schema.image = images;
  const labels = [...new Set((Array.isArray(article.labels) ? article.labels : []).map((item) => clean(item, 120)).filter(Boolean))].slice(0, 20);
  if (labels.length) schema.keywords = labels.join(', ');
  const publishedAt = isoDate(input.publishedAt);
  const modifiedAt = isoDate(input.modifiedAt);
  if (publishedAt) schema.datePublished = publishedAt;
  if (modifiedAt) schema.dateModified = modifiedAt;
  return schema;
}

export function validateBlogPostingSchema(schema, options = {}) {
  const issues = [];
  const canonicalUrl = canonicalHttpUrl(options.canonicalUrl || schema?.url);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { version: 'smileseon-blogposting-schema.v1', passed: false, canonicalUrl, issues: ['SCHEMA_OBJECT_REQUIRED'] };
  }
  if (schema['@context'] !== 'https://schema.org') issues.push('SCHEMA_CONTEXT_INVALID');
  if (schema['@type'] !== 'BlogPosting') issues.push('SCHEMA_TYPE_INVALID');
  if (!clean(schema.headline, 300)) issues.push('SCHEMA_HEADLINE_REQUIRED');
  if (!clean(schema.description, 500)) issues.push('SCHEMA_DESCRIPTION_REQUIRED');
  if (!clean(schema.inLanguage, 20)) issues.push('SCHEMA_LANGUAGE_REQUIRED');
  const url = canonicalHttpUrl(schema.url);
  const mainId = canonicalHttpUrl(schema?.mainEntityOfPage?.['@id']);
  if (!canonicalUrl || url !== canonicalUrl || mainId !== canonicalUrl) issues.push('SCHEMA_CANONICAL_MISMATCH');
  if (schema.image !== undefined) {
    if (!Array.isArray(schema.image) || schema.image.length === 0 || schema.image.some((item) => !canonicalHttpUrl(item))) {
      issues.push('SCHEMA_IMAGE_INVALID');
    }
  }
  for (const key of ['datePublished', 'dateModified']) {
    if (schema[key] && !isoDate(schema[key])) issues.push(`SCHEMA_${key.toUpperCase()}_INVALID`);
  }
  return {
    version: 'smileseon-blogposting-schema.v1',
    passed: issues.length === 0,
    canonicalUrl,
    issues,
    schema
  };
}

export function buildValidatedBlogPostingSchema(input = {}) {
  const schema = buildBlogPostingSchema(input);
  return validateBlogPostingSchema(schema, { canonicalUrl: input.canonicalUrl });
}
