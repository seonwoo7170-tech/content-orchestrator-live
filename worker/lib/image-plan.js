function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(value, max) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function visualConcept(value) {
  return clampText(value, 100)
    .toLowerCase()
    .replace(/["“”'‘’`]/g, '')
    // \b\d+\b is meant to drop English listicle numbers ("5 Ways to..."), but \b only
    // treats [A-Za-z0-9_] as word characters -- a Korean particle glued directly onto a
    // number ("2026년") still counts as a boundary, so the whole number was silently
    // dropped and left a broken "년 파워서플라이..." topic feeding the image prompt
    // (confirmed on job #161). Skip the strip when a Hangul character follows immediately.
    .replace(/\b\d+\b(?![가-힣ᄀ-ᇿ㄰-㆏])/g, ' ')
    .replace(/\bhow\s+to\b/gi, ' ')
    .replace(/\b(ways?|tips?|steps?|things?)\s+to\s+(check|know|consider|try|do)\b/gi, ' ')
    .replace(/\b(find|test|check|inspect|verify|prepare|prioritize|stop|fix|troubleshoot|understand|use|using)\b/gi, ' ')
    .replace(/\b(your|my|our)\b/gi, ' ')
    .replace(/\b(before|after|when|while|without)\b.*$/gi, ' ')
    .replace(/\b(at\s+home|first|safely|safe|practical|complete)\b/gi, ' ')
    .replace(/\b(a|an|the)\b/gi, ' ')
    .replace(/\b(guide|framework|checklist|tips|steps)\b/gi, ' ')
    .replace(/\s*[:—–-]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(and|or|for|to)\s+/i, '')
    .replace(/\s+(and|or|for|to)$/i, '')
    .trim();
}

// Unlike visualConcept() (built for terse titles cluttered with listicle filler), a body
// paragraph is already a natural sentence -- stripping words like "before"/"after" would
// delete everything after them, and the check/inspect/verify filter would mangle ordinary
// grammar. Only clean it enough to be safe to embed in the prompt (no stray quotes).
function sceneDetail(value) {
  return clampText(value, 160).replace(/["“”'‘’`]/g, '').replace(/[.!?。！？]+$/, '').trim();
}

// A section's <h2> alone is often too short/terse to ground an image accurately (e.g.
// "ATX 규격과 12V 2X6 커넥터의 이해" gave the image model almost nothing to work with and it
// hallucinated an unrelated scene). Pairing the heading with the first sentence of the
// paragraph that actually explains it gives the model real content to anchor on, not just
// a label. Only the heading is still used standalone as a display fallback (alt text, etc).
function extractSections(html) {
  const raw = String(html || '');
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const matches = [...raw.matchAll(re)];
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const heading = clampText(matches[index][1], 120);
    if (!heading) continue;
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    // A period is only a sentence end when it isn't immediately followed by a digit --
    // otherwise a decimal-style token like "ATX3.0" or "12V-2x6" truncates the detail
    // after just "atx3" instead of the actual explanatory sentence.
    const sectionText = clampText(raw.slice(start, end), 400);
    const firstSentence = sectionText.match(/^.*?[.!?。！？](?!\d)/)?.[0] || sectionText;
    sections.push({ heading, detail: sceneDetail(firstSentence) });
  }
  return sections;
}

function abstractVisualHeading(value) {
  const text = cleanText(value).toLowerCase();
  return /^(direct answer|quick answer|overview|summary|introduction|conclusion|final thoughts|reader questions?|faq|frequently asked|common mistakes?|decision criteria|key takeaways?|what to know)|^(핵심 답변|빠른 답변|요약|개요|서론|결론|자주 묻는 질문|독자 질문|흔한 실수|판단 기준|핵심 정리)/i.test(text);
}

export const DEFAULT_BODY_IMAGE_COUNT = 4;
export const MAX_BODY_IMAGE_COUNT = 6;

export function normalizeBodyCount(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BODY_IMAGE_COUNT;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > MAX_BODY_IMAGE_COUNT) throw new Error('BODY_IMAGE_COUNT_INVALID');
  return count;
}

function articleIdentity(article) {
  if (!article || typeof article !== 'object') throw new Error('ARTICLE_REQUIRED');
  const title = clampText(article.title, 160);
  const topic = clampText(article.topic || article.title, 160);
  if (!title) throw new Error('ARTICLE_TITLE_REQUIRED');
  if (!topic) throw new Error('ARTICLE_TOPIC_REQUIRED');
  return { title, topic };
}

function imageAltText(article, text, role) {
  const language = String(article?.language || '').toLowerCase();
  if (language === 'en') return clampText(role === 'thumbnail' ? `${text} featured image` : `${text} explanatory image`, 120);
  return clampText(role === 'thumbnail' ? `${text} 대표 이미지` : `${text} 관련 설명 이미지`, 120);
}

function normalizeHook(value, language) {
  const text = cleanText(value)
    .replace(/^\s*[\d①-⑳]+[.)\-:]?\s*/, '')
    .replace(/[.!?。！？]+$/g, '')
    .trim();
  if (!text) return '';
  return clampText(text, language === 'ko' ? 22 : 38).replace(/…$/, '').trim();
}

export function buildThumbnailHook(article) {
  const language = String(article?.language || '').toLowerCase() === 'en' ? 'en' : 'ko';
  const title = cleanText(article?.title);
  const explicit = normalizeHook(article?.thumbnailHook, language);
  if (explicit && explicit.toLowerCase() !== title.toLowerCase()) return explicit;

  const lower = `${title} ${cleanText(article?.topic)}`.toLowerCase();
  if (language === 'en') {
    if (/(money|budget|cost|afford)/.test(lower) && /(repair|fix|home)/.test(lower)) return 'Fix the Risky Stuff First';
    if (/(error|problem|not working|failed|failure|fix|repair|troubleshoot)/.test(lower)) return 'Try This First';
    if (/(safe|safety|danger|warning|risk)/.test(lower)) return 'Don’t Ignore This';
    if (/(vs\.?|versus|compare|comparison|best)/.test(lower)) return 'What Matters Most';
    return 'Start Here';
  }

  if (/(돈|예산|비용|절약)/.test(lower) && /(수리|고장|집|주택)/.test(lower)) return '큰돈 들기 전에 먼저';
  if (/(오류|에러|고장|문제|안\s*됨|해결|수리)/.test(lower)) return '이것부터 확인';
  if (/(안전|위험|주의|경고)/.test(lower)) return '놓치면 안 되는 것';
  if (/(비교|추천|베스트|vs)/i.test(lower)) return '고를 때 핵심은 이것';
  return '핵심부터 확인';
}

function topicDominance(concept) {
  return `The physical subject represented by ${concept} must be clearly visible and remain the dominant visual focus. Use task-focused documentary framing. When a person is useful, show hands or forearms actively performing the relevant task while the physical subject remains dominant, rather than a posed portrait.`;
}

function thumbnailScene(concept) {
  return `Photorealistic real-world photograph focused on ${concept}. ${topicDominance(concept)} Depict tangible objects, tools, materials, fixtures, devices, and surroundings appropriate to the exact topic. One clear focal subject, natural lighting, realistic materials, uncluttered composition. Wide landscape framing with comfortable open space around the focal subject.`;
}

const BODY_SCENE_PURPOSES = [
  'Establish the relevant setting and show the subject in its everyday surroundings.',
  'Isolate a meaningful component or material detail in a tight close-up.',
  'Show the relevant equipment or objects arranged for a practical task, viewed from above.',
  'Show the subject in a realistic everyday use situation at eye level.',
  'Show a complementary side view of the relevant physical relationship between objects.',
  'Show the finished arrangement with emphasis on the useful physical result.'
];

function bodyScene(sectionConcept, sectionDetail, topicConcept, index) {
  const detailClause = sectionDetail ? ` This section explains: ${sectionDetail}.` : '';
  return `Photorealistic real-world photograph focused on ${sectionConcept} within the broader context of ${topicConcept}.${detailClause} ${topicDominance(topicConcept)} Show a concrete action, condition, material, fixture, tool interaction, or before-work detail that directly explains this section. ${BODY_SCENE_PURPOSES[index % BODY_SCENE_PURPOSES.length]} Keep the scene specific to the section subject; choose only physically relevant props. Natural lighting, realistic materials, useful close-to-medium distance, one clear focal subject, clean composition.`;
}

export function buildImagePlan(article, options = {}) {
  const { title, topic } = articleIdentity(article);
  const bodyCount = normalizeBodyCount(options.bodyCount);
  const sections = extractSections(article.html);
  const visualSections = sections.filter((entry) => !abstractVisualHeading(entry.heading));
  const topicConcept = visualConcept(topic) || visualConcept(title) || 'a practical everyday subject';
  const images = [
    {
      role: 'thumbnail',
      position: 0,
      prompt: thumbnailScene(topicConcept),
      altText: imageAltText(article, title, 'thumbnail'),
      hookText: buildThumbnailHook(article)
    }
  ];

  for (let index = 0; index < bodyCount; index += 1) {
    const section = (visualSections.length ? visualSections[index % visualSections.length] : null)
      || (sections.length ? sections[index % sections.length] : null)
      || { heading: topic, detail: '' };
    const sectionConcept = visualConcept(section.heading) || topicConcept;
    images.push({
      role: 'body',
      position: index + 1,
      prompt: bodyScene(sectionConcept, section.detail, topicConcept, index),
      altText: imageAltText(article, section.heading, 'body'),
      hookText: null
    });
  }

  return {
    title,
    topic,
    bodyCount,
    images
  };
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function figureHtml(image, loading) {
  return `<figure class="post-image post-image--${image.role}" data-job-image-id="${Number(image.id)}"><img src="${escapeAttr(image.public_url)}" alt="${escapeAttr(image.alt_text)}" loading="${loading}" decoding="async"></figure>`;
}

function distributionFractions(count) {
  if (count === 1) return [0.52];
  if (count === 2) return [0.34, 0.70];
  if (count === 3) return [0.25, 0.52, 0.78];
  return Array.from({ length: count }, (_, index) => (index + 1) / (count + 1));
}

function insertBodyImagesDistributed(html, bodyImages) {
  const pending = bodyImages.filter((image) => !html.includes(`data-job-image-id="${Number(image.id)}"`));
  if (!pending.length) return html;

  const paragraphCount = (html.match(/<\/p>/gi) || []).length;
  if (paragraphCount > 0) {
    const fractions = distributionFractions(pending.length);
    const targetIndexes = [];
    let previous = -1;
    for (let i = 0; i < pending.length; i += 1) {
      let target = Math.min(paragraphCount - 1, Math.max(0, Math.floor(paragraphCount * fractions[i])));
      if (target <= previous && previous + 1 < paragraphCount) target = previous + 1;
      targetIndexes.push(target);
      previous = target;
    }

    let paragraphIndex = -1;
    let imageIndex = 0;
    html = html.replace(/<\/p>/gi, (closingTag) => {
      paragraphIndex += 1;
      let insertion = closingTag;
      while (imageIndex < pending.length && targetIndexes[imageIndex] === paragraphIndex) {
        insertion += `\n${figureHtml(pending[imageIndex], 'lazy')}`;
        imageIndex += 1;
      }
      return insertion;
    });

    for (; imageIndex < pending.length; imageIndex += 1) {
      html += `\n${figureHtml(pending[imageIndex], 'lazy')}`;
    }
    return html;
  }

  let imageIndex = 0;
  html = html.replace(/(<h2\b[^>]*>[\s\S]*?<\/h2>)/gi, (heading) => {
    const image = pending[imageIndex++];
    if (!image) return heading;
    return `${heading}\n${figureHtml(image, 'lazy')}`;
  });
  for (; imageIndex < pending.length; imageIndex += 1) html += `\n${figureHtml(pending[imageIndex], 'lazy')}`;
  return html;
}

export function attachStoredImages(article, rows) {
  if (!article || typeof article !== 'object') throw new Error('ARTICLE_REQUIRED');
  const usable = (Array.isArray(rows) ? rows : [])
    .filter((row) => ['stored', 'attached'].includes(String(row.status)) && String(row.public_url || '').startsWith('https://'));
  const thumbnail = usable.find((row) => row.role === 'thumbnail');
  const bodyImages = usable.filter((row) => row.role === 'body').sort((a, b) => Number(a.position) - Number(b.position));

  let html = String(article.html || '');
  if (!html) throw new Error('ARTICLE_HTML_REQUIRED');

  if (thumbnail && !html.includes(`data-job-image-id="${Number(thumbnail.id)}"`)) {
    html = `${figureHtml(thumbnail, 'eager')}\n${html}`;
  }

  html = insertBodyImagesDistributed(html, bodyImages);
  return { ...article, html };
}
