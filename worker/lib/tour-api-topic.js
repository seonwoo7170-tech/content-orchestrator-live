import { tourApiConnectedBlogIds } from './klook-catalog.js';

// A small, fixed rotation of Statistics Korea legal-dong region codes (lDongRegnCd), the
// region parameter areaBasedList2 has used since TourAPI's v4.4 revision. Seoul=11,
// Busan=26, Incheon=28, Gyeongsangbuk-do (Gyeongju)=35, Jeju=39 -- all well-covered by
// EngService2, chosen to keep this from stalling on a single sparsely-covered region.
const REGION_ROTATION = ['11', '26', '28', '35', '39'];

function normalizedTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function regionRotationStartIndex(now) {
  const dayIndex = Math.floor(now.getTime() / 86400000);
  return dayIndex % REGION_ROTATION.length;
}

// Recent post titles are the full wrapped phrase buildAttractionTopic() below produces
// ("경복궁 여행 전 꼭 알아야 할 것들"), never the bare attraction name alone -- an exact-match
// check against normalizedTitle(attraction.title) would never match anything and this dedup
// would be a no-op. Check whether the attraction's own name appears inside any recent title.
function alreadyCovered(attractionTitle, seenTitles) {
  const needle = normalizedTitle(attractionTitle);
  if (!needle) return false;
  for (const title of seenTitles) {
    if (title.includes(needle)) return true;
  }
  return false;
}

function buildAttractionTopic(attraction, language) {
  const name = String(attraction?.title || '').trim();
  if (String(language || '').toLowerCase() === 'en') return `Visiting ${name}: What to Know Before You Go`;
  return `${name} 여행 전 꼭 알아야 할 것들`;
}

// Picks one real TourAPI attraction this blog hasn't already written about, so the resulting
// article can be grounded by tourApiContentId end to end: job-runner.js already passes
// job.tourApiContentId through to the writer, and real-photo-images.js already prioritizes
// the writer's resulting attractionImages over AI-generated body images. The only piece that
// was ever missing was automatically selecting one during daily planning (previously this
// only ever happened through the manual "새 글" form's tourApiContentId field) -- confirmed
// on Smile Atlas jobs whose auto-planned topics ("Avoid cultural slip-ups", "Pack Smart for
// Korea") named no specific place at all, so neither real-photo path could ever fire and
// every body image fell through to generic AI generation, 2026-09-20.
export async function selectTourApiAttractionTopic(env, {
  blogId,
  language,
  recentPosts = [],
  excludeContentIds = [],
  callHubFn,
  now = new Date()
} = {}) {
  if (!tourApiConnectedBlogIds(env).has(String(blogId || '').trim())) return null;
  if (typeof callHubFn !== 'function') return null;

  const seenTitles = new Set((recentPosts || []).map((post) => normalizedTitle(post?.title)).filter(Boolean));
  const excluded = new Set((excludeContentIds || []).map(String));
  const start = regionRotationStartIndex(now);

  for (let offset = 0; offset < REGION_ROTATION.length; offset += 1) {
    const region = REGION_ROTATION[(start + offset) % REGION_ROTATION.length];
    let page;
    try {
      page = await callHubFn(env, env.HUB_TOUR_ATTRACTIONS_PATH || '/api/hub/tour/attractions', {
        lDongRegnCd: region,
        numOfRows: 20,
        pageNo: 1
      });
    } catch {
      continue;
    }
    const attractions = Array.isArray(page?.attractions) ? page.attractions : [];
    const candidate = attractions.find((item) => (
      item?.contentId
      && item?.title
      && !excluded.has(String(item.contentId))
      && !alreadyCovered(item.title, seenTitles)
    ));
    if (candidate) {
      return {
        topic: buildAttractionTopic(candidate, language),
        tourApiContentId: String(candidate.contentId)
      };
    }
  }
  return null;
}
