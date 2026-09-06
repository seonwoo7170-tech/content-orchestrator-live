export const DEFAULT_DAILY_POLICY = Object.freeze({
  newArticlesPerBlog: 1,
  repairsPerBlog: 1
});

export function dateInTimeZone(now = new Date(), timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeDailyPolicy(policy = {}) {
  const normalized = {
    newArticlesPerBlog: Number(policy.newArticlesPerBlog ?? DEFAULT_DAILY_POLICY.newArticlesPerBlog),
    repairsPerBlog: Number(policy.repairsPerBlog ?? DEFAULT_DAILY_POLICY.repairsPerBlog)
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      throw new Error(`DAILY_POLICY_${key.toUpperCase()}_INVALID`);
    }
  }
  return normalized;
}

export function buildDailySlots(blogs, planDate, policy = DEFAULT_DAILY_POLICY) {
  if (!Array.isArray(blogs)) throw new Error('BLOG_LIST_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(planDate || ''))) throw new Error('PLAN_DATE_INVALID');
  const normalized = normalizeDailyPolicy(policy);
  const slots = [];

  for (const blog of blogs) {
    const blogId = String(blog?.blogId || '').trim();
    if (!blogId) throw new Error('BLOG_ID_REQUIRED');
    for (let slotNo = 1; slotNo <= normalized.newArticlesPerBlog; slotNo += 1) {
      slots.push({ planDate, blogId, blogName: blog.name || null, kind: 'new_article', slotNo });
    }
    for (let slotNo = 1; slotNo <= normalized.repairsPerBlog; slotNo += 1) {
      slots.push({ planDate, blogId, blogName: blog.name || null, kind: 'repair_existing', slotNo });
    }
  }
  return slots;
}
