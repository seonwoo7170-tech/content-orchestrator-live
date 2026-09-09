import { runPrimaryWithGeminiFallback } from './ai-provider-router.js';
import { parseJsonText } from './contracts.js';

const TOPIC_SYSTEM = `You are a conservative blog topic planner for an automated Blogger system.
Choose exactly one useful evergreen topic that fits the supplied blog name, URL, language, operation mode, and recent post titles.
Avoid exact or near duplicates of the recent titles. Prefer practical search-intent topics a normal reader can act on. For language=en, preserve title-pattern diversity as well as topic diversity: inspect the openings of recent English titles and do not default every English topic to "How to". Use "How to" only when the search intent is genuinely procedural or step-by-step. For explanation, diagnosis, comparison, selection, timing, cost, suitability, definition, or troubleshooting intent, prefer the most natural form for the query, including Why, What, Which, When, Can, Should, Is/Are, Does/Do, How Much, How Long, How Often, or a concise natural non-question title. Do not force an awkward question word merely for variety, and avoid repeating a dominant recent opening pattern when another natural search-oriented form fits. Do not choose breaking news, current prices, unsupported product claims, medical/legal/financial high-stakes advice, or a topic that would require invented first-hand experience. Do not mention automation or AI unless the blog itself is about AI.
Return JSON only with this exact shape: {"topic":"..."}. The topic must be a concise article topic, not an outline, instruction, explanation, title list, or commentary.`;

const TOPIC_SCHEMA = Object.freeze({
  type: 'object',
  properties: { topic: { type: 'string' } },
  required: ['topic']
});

function normalizeRecentPosts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((item) => ({
    title: String(item?.title || '').trim().slice(0, 240),
    labels: Array.isArray(item?.labels) ? item.labels.map(String).slice(0, 10) : []
  })).filter((item) => item.title);
}

function normalizedTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function validatePlannedTopic(value, input = {}) {
  const topic = String(value?.topic || value || '').replace(/\s+/g, ' ').trim();
  if (topic.length < 12 || topic.length > 180) {
    const error = new Error('TOPIC_PLANNER_TOPIC_LENGTH_INVALID');
    error.status = 502;
    throw error;
  }
  const normalized = normalizedTitle(topic);
  const recent = normalizeRecentPosts(input?.recentPosts);
  if (recent.some((item) => normalizedTitle(item.title) === normalized)) {
    const error = new Error('TOPIC_PLANNER_DUPLICATE_TITLE');
    error.status = 502;
    throw error;
  }
  return topic;
}

export async function planTopic(env, input = {}, aiBinding = env?.AI, fetchImpl = fetch) {
  const blogId = String(input?.blogId || '').trim();
  const blogName = String(input?.blogName || '').trim();
  const blogUrl = String(input?.blogUrl || '').trim();
  const language = String(input?.language || '').trim().toLowerCase();
  const operationMode = String(input?.operationMode || 'validation').trim().toLowerCase();
  if (!blogId) throw Object.assign(new Error('TOPIC_PLANNER_BLOG_ID_REQUIRED'), { status: 400 });
  if (!blogName) throw Object.assign(new Error('TOPIC_PLANNER_BLOG_NAME_REQUIRED'), { status: 400 });
  if (!['ko', 'en'].includes(language)) throw Object.assign(new Error('TOPIC_PLANNER_LANGUAGE_INVALID'), { status: 400 });
  if (!['growth', 'recovery', 'validation'].includes(operationMode)) {
    throw Object.assign(new Error('TOPIC_PLANNER_OPERATION_MODE_INVALID'), { status: 400 });
  }

  const recentPosts = normalizeRecentPosts(input?.recentPosts);
  const userContent = JSON.stringify({
    blogId,
    blogName,
    blogUrl: blogUrl || null,
    language,
    operationMode,
    recentPosts
  });
  const cloudflareModel = env.WRITER_MODEL || '@cf/openai/gpt-oss-120b';
  const geminiModel = env.GEMINI_WRITER_MODEL || 'gemini-3.5-flash-lite';
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: 'system', content: TOPIC_SYSTEM },
        { role: 'user', content: userContent }
      ],
      maxTokens: 512
    },
    gemini: {
      model: geminiModel,
      systemInstruction: TOPIC_SYSTEM,
      userContent,
      maxOutputTokens: 512,
      thinking: 'minimal',
      responseSchema: TOPIC_SCHEMA
    }
  }, aiBinding, fetchImpl);

  let parsed;
  try { parsed = parseJsonText(result.response); } catch {
    throw Object.assign(new Error('TOPIC_PLANNER_JSON_INVALID'), { status: 502 });
  }
  const topic = validatePlannedTopic(parsed, { recentPosts });
  return {
    topic,
    provider: result.provider,
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    primaryError: result.primaryError,
    usage: result.usage
  };
}
