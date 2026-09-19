import { requireBucket, publicBaseUrl, storeImageBytes, sourceImageMimeType } from './image-executor.js';

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

async function downloadRealPhoto(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`REAL_PHOTO_FETCH_FAILED:${response.status}`);
  const mimeType = sourceImageMimeType(response.headers.get('content-type') || 'image/jpeg');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new Error('REAL_PHOTO_SIZE_INVALID');
  return { bytes, mimeType };
}

// Fills only 'planned' body-role rows -- the thumbnail keeps its AI-generated hook caption
// (buildThumbnailHook in image-plan.js bakes the article title into it), which a bare
// attraction/product photo can't carry. A slot that downloads and stores successfully is
// marked 'stored' directly, which is enough for generatePlannedImages()'s orderedCandidates()
// to skip it afterward (isResumableImageStatus() only resumes planned/generating/generated/
// failed rows) -- no KIE call, no Gemini QA gate, no retry budget spent on a photo that
// already exists. A slot whose download fails is left 'planned' so the normal KIE path
// picks it up next, exactly as if no real photo had ever been offered for it.
export async function fillBodyImagesFromRealPhotos(env, jobId, images, photoUrls, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const urls = Array.isArray(photoUrls)
    ? photoUrls.filter((url) => /^https:\/\//i.test(String(url || '')))
    : [];
  if (urls.length === 0) return { attempted: 0, filled: 0 };

  const bucket = requireBucket(env, options.bucket);
  const baseUrl = publicBaseUrl(env);
  const bodySlots = (Array.isArray(images) ? images : [])
    .filter((image) => image.role === 'body' && String(image.status) === 'planned')
    .sort((a, b) => Number(a.position) - Number(b.position));

  let filled = 0;
  const attempted = Math.min(bodySlots.length, urls.length);
  for (let index = 0; index < attempted; index += 1) {
    const image = bodySlots[index];
    try {
      const { bytes, mimeType } = await downloadRealPhoto(urls[index], fetchImpl);
      await storeImageBytes(
        env, bucket, baseUrl, jobId, image, bytes, mimeType,
        { provider: 'tour-api', model: null },
        { sourceMimeType: mimeType, postprocessed: 'real-photo' }
      );
      filled += 1;
    } catch {
      // Leave 'planned' -- see the function-level note above.
    }
  }
  return { attempted, filled };
}
