import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveMediaUrls,
  type DispatchQueryable,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

type PostRow = { id: string; tenant_id: string; job_id: string | null };
type AssetRow = {
  id: number;
  tenant_id: string;
  source_job_id: string | null;
  storage_key: string | null;
  storage_kind: string;
  orphaned_at: string | null;
};

// In-memory fake that reproduces the join semantics of resolveMediaUrls'
// query: creative_assets joined to posts on (job_id = source_job_id, tenant),
// filtered to a single post id.
function buildFakeDb(posts: PostRow[], assets: AssetRow[]): DispatchQueryable {
  return {
    query: async <T = Record<string, unknown>>(_sql: string, params: unknown[]) => {
      const [postId, tenantId] = params as [string, string];
      const post = posts.find((p) => p.id === postId && p.tenant_id === tenantId);
      if (!post || !post.job_id) {
        return { rows: [] as T[], rowCount: 0 };
      }
      const matched = assets
        .filter(
          (a) =>
            a.tenant_id === tenantId &&
            a.source_job_id === post.job_id &&
            a.storage_key !== null &&
            a.orphaned_at === null &&
            ['hermes', 'local', 'url'].includes(a.storage_kind),
        )
        .sort((l, r) => r.id - l.id)
        .slice(0, 4)
        .map((a) => ({ storage_key: a.storage_key as string, storage_kind: a.storage_kind }));
      return { rows: matched as unknown as T[], rowCount: matched.length };
    },
  };
}

test('resolveMediaUrls returns only the dispatched post\'s assets, not the whole tenant\'s', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [
    { id: '100', tenant_id: tenantId, job_id: 'job-A' },
    { id: '200', tenant_id: tenantId, job_id: 'job-B' },
  ];
  const assets: AssetRow[] = [
    { id: 1, tenant_id: tenantId, source_job_id: 'job-A', storage_key: 'a/img-a1.png', storage_kind: 'hermes', orphaned_at: null },
    { id: 2, tenant_id: tenantId, source_job_id: 'job-A', storage_key: 'a/img-a2.png', storage_kind: 'hermes', orphaned_at: null },
    { id: 3, tenant_id: tenantId, source_job_id: 'job-B', storage_key: 'b/img-b1.png', storage_kind: 'hermes', orphaned_at: null },
  ];
  const db = buildFakeDb(posts, assets);

  const urlsA = await resolveMediaUrls('100', tenantId, db);
  assert.equal(urlsA.length, 2, 'post A has exactly 2 assets');
  assert.ok(urlsA.every((u) => u.includes('img-a')), `post A urls must be A's assets only: ${JSON.stringify(urlsA)}`);
  assert.ok(!urlsA.some((u) => u.includes('img-b')), "post A must NOT include post B's assets");

  const urlsB = await resolveMediaUrls('200', tenantId, db);
  assert.equal(urlsB.length, 1, 'post B has exactly 1 asset');
  assert.ok(urlsB[0].includes('img-b1'), 'post B url must be B\'s asset');
});

test('resolveMediaUrls returns empty when the post has no job_id linkage', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [{ id: '300', tenant_id: tenantId, job_id: null }];
  const assets: AssetRow[] = [
    { id: 1, tenant_id: tenantId, source_job_id: 'job-A', storage_key: 'a/img-a1.png', storage_kind: 'hermes', orphaned_at: null },
  ];
  const urls = await resolveMediaUrls('300', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, [], 'a post with no job_id resolves no assets, never the tenant fallback set');
});
