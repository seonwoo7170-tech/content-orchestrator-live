import test from 'node:test';
import assert from 'node:assert/strict';
import { listGa4Coverage } from '../worker/lib/ga4-coverage.js';

function envWith(rows) {
  return {
    ORCHESTRATOR_DB: {
      prepare() {
        return {
          async all() { return { results: rows }; }
        };
      }
    }
  };
}

test('GA4 coverage counts only managed Blogger blogs and leaves missing mappings explicit', async () => {
  const result = await listGa4Coverage(envWith([
    { blog_id: '1', property_id: '101', data_stream_id: 's1', default_uri: 'https://a.blogspot.com', measurement_id: 'G-A', match_type: 'exact_url' },
    { blog_id: 'legacy', property_id: '999', default_uri: 'https://old.tistory.com', match_type: 'exact_url' }
  ]), [
    { blogId: '1', name: 'A', url: 'https://a.blogspot.com' },
    { blogId: '2', name: 'B', url: 'https://b.example.com' },
    { blogId: 'legacy', name: 'Old', url: 'https://old.tistory.com' }
  ]);

  assert.equal(result.totalCount, 2);
  assert.equal(result.configuredCount, 1);
  assert.equal(result.unmappedCount, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.rows.map((row) => [row.blogId, row.status]), [['1', 'configured'], ['2', 'unmapped']]);
});

test('GA4 coverage is complete only when every managed Blogger blog has a property mapping', async () => {
  const result = await listGa4Coverage(envWith([
    { blog_id: '1', property_id: '101', match_type: 'hostname_data' },
    { blog_id: '2', property_id: '202', match_type: 'exact_url' }
  ]), [
    { blogId: '1', url: 'https://a.blogspot.com' },
    { blogId: '2', url: 'https://b.blogspot.com' }
  ]);

  assert.equal(result.complete, true);
  assert.equal(result.configuredCount, 2);
  assert.equal(result.unmappedCount, 0);
});
