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
  served_asset_ref: string | null;
  orphaned_at: string | null;
};

// In-memory fake that reproduces the SQL semantics of resolveMediaUrls'
// query: creative_assets joined to posts on (job_id = source_job_id, tenant),
// filtered to a single post id and the usable storage_kind values.
const USABLE_KINDS = ['runtime_asset', 'ingested_asset', 'external_url'];

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
            a.orphaned_at === null &&
            USABLE_KINDS.includes(a.storage_kind),
        )
        .sort((l, r) => r.id - l.id)
        .slice(0, 4)
        .map((a) => ({
          storage_key: a.storage_key,
          storage_kind: a.storage_kind,
          served_asset_ref: a.served_asset_ref,
        }));
      return { rows: matched as unknown as T[], rowCount: matched.length };
    },
  };
}

// A runtime_asset row as ingest-production-assets.ts writes it: storage_key is
// a host filesystem path, served_asset_ref is the servable media-route ref.
function runtimeAsset(id: number, tenantId: string, jobId: string, basename: string): AssetRow {
  return {
    id,
    tenant_id: tenantId,
    source_job_id: jobId,
    storage_key: `/home/node/.hermes/cache/images/${basename}`,
    storage_kind: 'runtime_asset',
    served_asset_ref: `/api/internal/hermes/media/${basename}`,
    orphaned_at: null,
  };
}

test('resolveMediaUrls returns only the dispatched post\'s assets, not the whole tenant\'s', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [
    { id: '100', tenant_id: tenantId, job_id: 'job-A' },
    { id: '200', tenant_id: tenantId, job_id: 'job-B' },
  ];
  const assets: AssetRow[] = [
    runtimeAsset(1, tenantId, 'job-A', 'img-a1.png'),
    runtimeAsset(2, tenantId, 'job-A', 'img-a2.png'),
    runtimeAsset(3, tenantId, 'job-B', 'img-b1.png'),
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
  const assets: AssetRow[] = [runtimeAsset(1, tenantId, 'job-A', 'img-a1.png')];
  const urls = await resolveMediaUrls('300', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, [], 'a post with no job_id resolves no assets, never the tenant fallback set');
});

test('resolveMediaUrls resolves a runtime_asset row to a non-empty media URL', async () => {
  // Regression for the storage_kind filter bug: runtime_asset is the value
  // Aries-generated images actually carry, but the old filter looked for
  // 'hermes'/'local'/'url' and returned nothing for every real post.
  const tenantId = '7';
  process.env.APP_BASE_URL = 'https://aries.example.test';
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A' }];
  const assets: AssetRow[] = [runtimeAsset(1, tenantId, 'job-A', 'campaign-hero.png')];

  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.equal(urls.length, 1, 'a runtime_asset row must resolve to exactly one media URL');
  assert.equal(
    urls[0],
    'https://aries.example.test/api/internal/hermes/media/campaign-hero.png',
    'runtime_asset must serve via the Hermes media route using served_asset_ref, not the host storage_key',
  );
});

test('resolveMediaUrls returns an external_url asset\'s storage_key URL as-is', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A' }];
  const assets: AssetRow[] = [
    {
      id: 1,
      tenant_id: tenantId,
      source_job_id: 'job-A',
      storage_key: 'https://cdn.example.com/external/photo.jpg',
      storage_kind: 'external_url',
      served_asset_ref: null,
      orphaned_at: null,
    },
  ];
  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, ['https://cdn.example.com/external/photo.jpg']);
});

test('resolveMediaUrls skips runtime_asset rows with no served_asset_ref', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A' }];
  const assets: AssetRow[] = [
    {
      id: 1,
      tenant_id: tenantId,
      source_job_id: 'job-A',
      storage_key: '/home/node/.hermes/cache/images/orphan.png',
      storage_kind: 'runtime_asset',
      served_asset_ref: null,
      orphaned_at: null,
    },
  ];
  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, [], 'a row with no servable ref is skipped, never served from a host path');
});
