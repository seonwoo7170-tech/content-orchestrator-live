import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workerIndex = fs.readFileSync('worker/index.js', 'utf8');

test('the manual image-retry endpoint tries real photos before ever asking KIE for a stand-in', () => {
  // A job stuck at KIE_RETRY_BUDGET_EXHAUSTED from before this fallback existed only gets
  // a chance at it once its images are reset to 'planned' and this endpoint runs again --
  // see resetFailedImageForRetry in image-store.js and the "이미지 재시도" button in
  // web/work-cards.js, which calls this exact route after resetting.
  const start = workerIndex.indexOf("const generateImagesJobId = matchJobImagePath(url.pathname, 'generate');");
  const end = workerIndex.indexOf("const attachImagesJobId = matchJobImagePath(url.pathname, 'attach');");
  assert.ok(start >= 0 && end > start);
  const route = workerIndex.slice(start, end);

  assert.match(route, /applyRealPhotoFallback\(env, generateImagesJobId,/);
  const fallbackIndex = route.indexOf('applyRealPhotoFallback(');
  const generateIndex = route.indexOf('generatePlannedImages(env, generateImagesJobId,');
  assert.ok(fallbackIndex >= 0 && generateIndex > fallbackIndex, 'applyRealPhotoFallback must run before generatePlannedImages');
  assert.match(route, /mode: generateImagesRow\.mode, blogId: generateImagesRow\.blog_id, result/);
});

test('the fallback helper is imported at module scope', () => {
  assert.match(workerIndex, /import \{ applyRealPhotoFallback \} from '\.\/lib\/real-photo-images\.js';/);
});
