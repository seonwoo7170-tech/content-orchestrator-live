import { buildDeliveryEvidence } from './delivery-evidence.js';
import { buildValidatedBlogPostingSchema } from './blogposting-schema.js';

function pendingSchema(reason = 'CANONICAL_URL_PENDING') {
  return {
    version: 'smileseon-blogposting-schema.v1',
    passed: false,
    canonicalUrl: null,
    issues: [reason],
    schema: null
  };
}

export function canonicalSchemaEvidence(result, publication, readback) {
  const canonicalUrl = readback?.identity?.permalink || null;
  if (!canonicalUrl) return pendingSchema();
  try {
    return buildValidatedBlogPostingSchema({
      article: result?.article,
      canonicalUrl,
      publishedAt: publication?.scheduledAt || publication?.publishedAt || publication?.updatedAt || null,
      modifiedAt: publication?.updatedAt || publication?.scheduledAt || null
    });
  } catch (error) {
    return pendingSchema(String(error?.message || 'SCHEMA_BUILD_FAILED').split(/[:\s]/)[0].slice(0, 80));
  }
}

export function buildSchemaAwareDelivery({
  mode,
  result,
  deterministicQa,
  naturalWritingStatus,
  images,
  imagesRequired,
  publication,
  readback
} = {}) {
  const schema = canonicalSchemaEvidence(result, publication, readback);
  const deliveryEvidence = buildDeliveryEvidence({
    mode,
    result,
    deterministicQa,
    naturalWritingStatus,
    images,
    imagesRequired,
    publication,
    readback,
    schema,
    schemaRequired: true
  });
  return {
    schema,
    structuredData: {
      blogPosting: schema.schema || null,
      validation: {
        version: schema.version,
        passed: schema.passed,
        canonicalUrl: schema.canonicalUrl,
        issues: schema.issues || []
      }
    },
    deliveryEvidence
  };
}
