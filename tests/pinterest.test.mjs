import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPinterestCreatePayload,
  classifyPinterestWriteFailure,
  createPinterestPin,
  pinterestDeliveryConfigured
} from '../worker/lib/pinterest.js';

test('Pinterest payload uses official image_url Pin shape with tracked link', () => {
  const payload = buildPinterestCreatePayload({
    title: 'A practical home fix',
    description: 'Useful steps',
    imageUrl: 'https://cdn.example.com/thumb.png',
    trackedDestinationUrl: 'https://content-orchestrator.smileseon.workers.dev/go/x123'
  }, { destinationId: 'board-123' });
  assert.equal(payload.board_id, 'board-123');
  assert.equal(payload.link, 'https://content-orchestrator.smileseon.workers.dev/go/x123');
  assert.deepEqual(payload.media_source, {
    source_type: 'image_url',
    url: 'https://cdn.example.com/thumb.png',
    is_standard: true
  });
});

test('Pinterest token is considered configured only when present', () => {
  assert.equal(pinterestDeliveryConfigured({}), false);
  assert.equal(pinterestDeliveryConfigured({ PINTEREST_ACCESS_TOKEN: ' token ' }), true);
});

test('Pinterest write is blocked by the global external delivery gate', async () => {
  let called = false;
  await assert.rejects(
    () => createPinterestPin({ EXTERNAL_DISTRIBUTION_ENABLED: 'false', PINTEREST_ACCESS_TOKEN: 'secret' }, {}, {}, async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }),
    /EXTERNAL_DISTRIBUTION_DISABLED/
  );
  assert.equal(called, false);
});

test('Pinterest create sends the secret only in Authorization and never retries internally', async () => {
  let calls = 0;
  let captured;
  const result = await createPinterestPin({
    EXTERNAL_DISTRIBUTION_ENABLED: 'true',
    PINTEREST_ACCESS_TOKEN: 'top-secret'
  }, {
    title: 'Title', description: 'Description',
    imageUrl: 'https://cdn.example.com/a.png',
    trackedDestinationUrl: 'https://example.com/go/x'
  }, { destinationId: 'board-1' }, async (url, init) => {
    calls += 1;
    captured = { url, init };
    return new Response(JSON.stringify({ id: 'pin-1', board_id: 'board-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://api.pinterest.com/v5/pins');
  assert.equal(captured.init.headers.authorization, 'Bearer top-secret');
  assert.doesNotMatch(captured.init.body, /top-secret/);
  assert.equal(result.pinId, 'pin-1');
});

test('ambiguous Pinterest write failures are held instead of automatically retried', () => {
  assert.deepEqual(classifyPinterestWriteFailure({ status: 503 }), { code: 'PINTEREST_HTTP_503', retryable: false, ambiguous: true });
  assert.deepEqual(classifyPinterestWriteFailure({ error: Object.assign(new Error('timeout'), { code: 'PINTEREST_TIMEOUT' }) }), { code: 'PINTEREST_AMBIGUOUS_NETWORK', retryable: false, ambiguous: true });
  assert.deepEqual(classifyPinterestWriteFailure({ status: 429 }), { code: 'PINTEREST_RATE_LIMIT', retryable: true, ambiguous: false });
});
