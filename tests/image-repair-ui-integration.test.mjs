import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('3-minute watchdog runs a leased KIE-first image lane without fixed serial pacing', async () => {
  const [entry, lock, migration] = await Promise.all([
    readFile(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8'),
    readFile(new URL('../worker/lib/runtime-lock.js', import.meta.url), 'utf8'),
    readFile(new URL('../worker/migrations/0025_runtime_locks.sql', import.meta.url), 'utf8')
  ]);
  const imagePart = entry.slice(entry.indexOf('async function runSerialImageWatchdog'), entry.indexOf('async function runLegacyMaintenance'));
  assert.match(entry, /runScheduledImageCompletion/);
  assert.doesNotMatch(imagePart, /await sleep\(cooldownMs\)/);
  assert.match(entry, /SERIAL_IMAGE_CHAIN_MAX_ITEMS, 8/);
  assert.match(entry, /maxJobs:\s*maxItems/);
  assert.match(entry, /maxImages:\s*1/);
  assert.match(entry, /cooldownMs:\s*0/);
  assert.match(entry, /providerPriority:\s*'kie->cloudflare'/);
  assert.match(entry, /acquireRuntimeLock/);
  assert.match(entry, /renewRuntimeLock/);
  assert.match(entry, /releaseRuntimeLock/);
  assert.match(entry, /IMAGE_LANE_BUSY/);
  assert.match(entry, /SERIAL_IMAGE_WATCHDOG/);
  assert.match(entry, /Promise\.all\(\[\s*runSerialAiWatchdog[\s\S]*runSerialImageWatchdog/);
  assert.match(lock, /ON CONFLICT\(lock_key\) DO UPDATE/);
  assert.match(lock, /runtime_locks\.expires_at <= \?/);
  assert.match(lock, /owner_token = \?/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS runtime_locks/);
});

test('repair publication hold recovery only releases same-post repair work and never treats a known post id as a new-post duplicate', async () => {
  const source = await readFile(new URL('../worker/lib/repair-hold-recovery.js', import.meta.url), 'utf8');
  assert.match(source, /j\.mode = 'repair_existing'/);
  assert.match(source, /publication_blogger_post_id/);
  assert.match(source, /recorded && recorded !== expected/);
  assert.match(source, /\['claimed', 'verification_pending', 'updated', 'published'\]/);
  assert.match(source, /READY_TO_UPDATE_EXISTING/);
  assert.match(source, /status = 'ready'/);
  assert.match(source, /REPAIR_SAFE_RETRY_RELEASED/);
});

test('mobile shell keeps bottom menus and adds contextual sidebar navigation with queue filters', async () => {
  const [html, js, css, sw] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/subnav.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/subnav.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/sw.js', import.meta.url), 'utf8')
  ]);
  for (const label of ['홈', '작업', '작성', '블로그', '설정']) assert.ok(html.includes(`<small>${label}</small>`));
  assert.match(html, /subnav\.css/);
  assert.match(html, /subnav\.js/);
  for (const label of ['이미지 대기', '재시도 대기', '확인 필요', '자동화 설정', 'AI 연결 진단']) assert.ok(js.includes(label));
  assert.match(css, /\.subnav-drawer/);
  assert.match(css, /\.job-row \.job-meta\{display:none\}/);
  assert.match(css, /\.job-row \.job-live-grid,.job-row \.job-live-flow\{display:none\}/);
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(sw, /subnav\.css/);
  assert.match(sw, /subnav\.js/);
  assert.match(sw, /work-live-progress\.js/);
  assert.match(sw, /live-work-progress\.js/);
});