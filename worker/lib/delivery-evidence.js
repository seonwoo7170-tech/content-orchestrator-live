function gate(id, label, passed, evidence = null, required = true) {
  return { id, label, required, passed: Boolean(passed), evidence };
}

function normalizedCritic(result) {
  const critic = result?.finalCritic || null;
  return {
    passed: Boolean(critic && critic.status === 'PASS' && Number(critic.score) >= 95 && (critic.issues || []).length === 0),
    evidence: critic ? { status: critic.status || null, score: Number(critic.score || 0), issueCount: Array.isArray(critic.issues) ? critic.issues.length : null } : null
  };
}

function normalizedArticle(result) {
  const article = result?.article || null;
  const passed = Boolean(article && typeof article === 'object' && String(article.title || '').trim() && String(article.html || '').trim());
  return { passed, evidence: article ? { title: String(article.title || '').slice(0, 180), language: article.language || null, topic: article.topic || null } : null };
}

function summarizeEvidence(evidence) {
  const gates = Array.isArray(evidence?.gates) ? evidence.gates : [];
  const required = gates.filter((item) => item.required !== false);
  const passedCount = required.filter((item) => item.passed).length;
  return {
    ...evidence,
    passedCount,
    requiredCount: required.length,
    status: passedCount === required.length && required.length > 0 ? 'PASS' : 'INCOMPLETE'
  };
}

export function validateBloggerReadback(expected = {}, readback = {}) {
  const identity = readback?.identity || {};
  const expectedBlogId = String(expected.blogId || '').trim();
  const expectedPostId = String(expected.bloggerPostId || '').trim();
  const actualBlogId = String(identity.blogId || '').trim();
  const actualPostId = String(identity.bloggerPostId || '').trim();
  const permalink = String(identity.permalink || readback?.rawMeta?.url || '').trim();
  const passed = Boolean(expectedBlogId && expectedPostId && actualBlogId === expectedBlogId && actualPostId === expectedPostId && permalink);
  return {
    passed,
    evidence: {
      expectedBlogId: expectedBlogId || null,
      expectedPostId: expectedPostId || null,
      actualBlogId: actualBlogId || null,
      actualPostId: actualPostId || null,
      permalink: permalink || null,
      bloggerStatus: identity.status || null
    }
  };
}

export function buildDeliveryEvidence({
  mode = 'new_article',
  result,
  deterministicQa,
  naturalWritingStatus,
  images = null,
  imagesRequired = true,
  publication = null,
  readback = null,
  schema = null,
  schemaRequired = false
} = {}) {
  const article = normalizedArticle(result);
  const critic = normalizedCritic(result);
  const qaPassed = Boolean(deterministicQa && deterministicQa.status !== 'BLOCK');
  const naturalPassed = String(naturalWritingStatus || '').toUpperCase() !== 'BLOCK';
  const imagePassed = !imagesRequired || Boolean(images?.passed ?? images?.ok ?? false);
  const publicationPassed = Boolean(publication?.ok && publication?.bloggerPostId && publication?.blogId);
  const readbackCheck = publicationPassed && readback
    ? validateBloggerReadback({ blogId: publication.blogId, bloggerPostId: publication.bloggerPostId }, readback)
    : { passed: false, evidence: null };
  const schemaPassed = !schemaRequired || Boolean(schema?.passed ?? schema?.ok ?? false);

  return summarizeEvidence({
    version: 'smileseon-delivery-evidence.v1',
    mode,
    gates: [
      gate('article', '작성 결과', article.passed, article.evidence),
      gate('final_critic', '최종 Critic', critic.passed, critic.evidence),
      gate('deterministic_qa', '기계 QA', qaPassed, deterministicQa ? { status: deterministicQa.status, issueCount: deterministicQa.issues?.length || 0, version: deterministicQa.version || null } : null),
      gate('natural_writing', '자연스러운 글쓰기 검사', naturalPassed, { status: naturalWritingStatus || null }),
      gate('images', '이미지 준비', imagePassed, images, imagesRequired),
      gate('schema', '구조화데이터', schemaPassed, schema, schemaRequired),
      gate('blogger_write', mode === 'repair_existing' ? 'Blogger 업데이트' : 'Blogger 저장', publicationPassed, publication ? { bloggerPostId: publication.bloggerPostId || null, url: publication.url || null, status: publication.status || null, publishMode: publication.publishMode || publication.mode || null } : null),
      gate('blogger_readback', 'Blogger 재확인', readbackCheck.passed, readbackCheck.evidence)
    ]
  });
}

export function withBloggerReadbackEvidence(evidence, expected, readback) {
  const current = evidence && typeof evidence === 'object'
    ? evidence
    : { version: 'smileseon-delivery-evidence.v1', mode: 'unknown', gates: [] };
  const check = validateBloggerReadback(expected, readback);
  const gates = Array.isArray(current.gates) ? current.gates.map((item) => ({ ...item })) : [];
  const index = gates.findIndex((item) => item.id === 'blogger_readback');
  const next = gate('blogger_readback', 'Blogger 재확인', check.passed, check.evidence);
  if (index >= 0) gates[index] = next;
  else gates.push(next);
  return summarizeEvidence({ ...current, gates });
}

export function deliveryEvidenceComplete(evidence) {
  return Boolean(evidence && evidence.status === 'PASS' && Number(evidence.passedCount) === Number(evidence.requiredCount));
}
