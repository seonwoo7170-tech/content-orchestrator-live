import test from 'node:test';
import assert from 'node:assert/strict';
import { bloggerOnly, loadConnectedBlogs, syncManagedBlogs } from '../worker/lib/connected-blogs.js';

function fakeDb(existingIds = []) {
  const rows = new Set(existingIds.map(String));
  const writes = [];
  return {
    rows,
    writes,
    prepare(sql) {
      if (sql.startsWith('SELECT blog_id FROM managed_blogs')) {
        return { all: async () => ({ results: [...rows].map((blog_id) => ({ blog_id })) }) };
      }
      return {
        bind(...values) {
          return {
            run: async () => {
              rows.add(String(values[0]));
              writes.push(values);
              return { success: true };
            }
          };
        }
      };
    }
  };
}

test('bloggerOnly excludes Tistory and keeps Blogger/custom-domain Blogger entries', () => {
  const result = bloggerOnly([
    { blogId: '1', url: 'https://a.blogspot.com' },
    { blogId: '2', url: 'https://custom.example.com' },
    { blogId: 'legacy', url: 'https://legacy.tistory.com' }
  ]);
  assert.deepEqual(result.map((row) => row.blogId), ['1', '2']);
});

test('syncManagedBlogs detects newly connected Blogger blogs without deleting existing rows', async () => {
  const db = fakeDb(['1']);
  const result = await syncManagedBlogs({ ORCHESTRATOR_DB: db }, [
    { blogId: '1', name: 'Existing', url: 'https://a.blogspot.com', language: 'ko', postsTotal: 10 },
    { blogId: '2', name: 'New', url: 'https://b.blogspot.com', language: 'en', postsTotal: 0 },
    { blogId: 'legacy', name: 'Old', url: 'https://legacy.tistory.com' }
  ]);

  assert.equal(result.synced, true);
  assert.deepEqual(result.newBlogIds, ['2']);
  assert.deepEqual([...db.rows].sort(), ['1', '2']);
  assert.equal(db.writes.length, 2);
});

test('loadConnectedBlogs auto-syncs normalized Blogger list from API Hub', async () => {
  const db = fakeDb();
  const blogs = await loadConnectedBlogs({ ORCHESTRATOR_DB: db }, {
    db,
    callHubFn: async () => ({ blogs: [
      { id: '10', name: 'Fresh', url: 'https://fresh.blogspot.com' },
      { id: 'old', name: 'Legacy', url: 'https://old.tistory.com' }
    ] })
  });

  assert.deepEqual(blogs.map((row) => row.blogId), ['10']);
  assert.deepEqual([...db.rows], ['10']);
});

test('syncManagedBlogs remains read-compatible when D1 is not bound', async () => {
  const result = await syncManagedBlogs({}, [{ blogId: '1', url: 'https://a.blogspot.com' }]);
  assert.deepEqual(result, { synced: false, reason: 'DB_NOT_BOUND', blogCount: 1, newBlogIds: [] });
});
