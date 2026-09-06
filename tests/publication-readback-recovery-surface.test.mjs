import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('publication recovery retries readback without creating another Blogger post', async () => {
  const source = await readFile(new URL('../worker/lib/publication-readback-recovery.js', import.meta.url), 'utf8');
  assert.match(source, /verification_pending/);
  assert.match(source, /HUB_BLOGGER_GET_PATH/);
  assert.doesNotMatch(source, /HUB_BLOGGER_POST_PATH/);
  assert.match(source, /bloggerPostId/);
});

test('publication recovery also heals jobs orphaned after publication row was committed', async () => {
  const source = await readFile(new URL('../worker/lib/publication-readback-recovery.js', import.meta.url), 'utf8');
  assert.match(source, /j\.status = 'publishing_new'/);
  assert.match(source, /p\.status IN \('scheduled', 'published'\)/);
  assert.match(source, /j\.status = 'updating_existing'/);
  assert.match(source, /p\.status = 'updated'/);
  assert.match(source, /AUTHORITATIVE_PUBLICATION_STATUSES/);
  assert.match(source, /VERIFIED_LEGACY_PUBLICATION_STATE/);
  assert.match(source, /recoveredFromPublicationStatus/);
});

test('watchdog reconciles pending Blogger readbacks before starting serial AI work', async () => {
  const source = await readFile(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
  assert.match(source, /reconcilePendingPublicationReadbacks/);
  assert.match(source, /PUBLICATION_READBACK_RECOVERY_FAILED/);
  assert.match(source, /publicationReadback/);
  const recoveryIndex = source.indexOf('recovery = await runScheduledJobRecovery');
  const publicationReadbackIndex = source.indexOf('publicationReadback = await reconcilePendingPublicationReadbacks');
  assert.ok(recoveryIndex >= 0);
  assert.ok(publicationReadbackIndex >= 0);
  assert.ok(publicationReadbackIndex < recoveryIndex);
});

test('auto publisher writes once and requires exact Blogger readback evidence before completed', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(source, /HUB_BLOGGER_POST_PATH/);
  assert.match(source, /HUB_BLOGGER_GET_PATH/);
  assert.match(source, /validateBloggerReadback/);
  assert.match(source, /verification_pending/);
  assert.match(source, /deliveryEvidenceComplete/);
  assert.ok(source.lastIndexOf("'completed'") > source.indexOf('deliveryEvidenceComplete'));
});
