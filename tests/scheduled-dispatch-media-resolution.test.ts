import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveMediaUrls,
  type DispatchQueryable,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

type PostRow = {
  id: string;
  tenant_id: string;
  job_id: string | null;
  creative_asset_ids: string[] | null;
};
type AssetRow = {
  id: string;
  tenant_id: string;
  source_job_id: string | null;
  source_asset_id: string | null;
  storage_key: string | null;
  storage_kind: string;
  served_asset_ref: string | null;
  orphaned_at: string | null;
};

// In-memory fake reproducing the SQL semantics of resolveMediaUrls' query:
// per-POST scoping via posts.creative_asset_ids (matched against creative_assets
// .id or .source_asset_id), with a job-scoped fallback when creative_asset_ids
// is empty/unset.
const USABLE_KINDS = ['runtime_asset', 'ingested_asset', 'external_url'];

function buildFakeDb(posts: PostRow[], assets: AssetRow[]): DispatchQueryable {
  return {
    query: async <T = Record<string, unknown>>(_sql: string, params: unknown[]) => {
      const [postId, tenantId] = params as [string, string];
      const post = posts.find((p) => p.id === postId && p.tenant_id === tenantId);
      if (!post) {
        return { rows: [] as T[], rowCount: 0 };
      }
      const ids = post.creative_asset_ids;
      const hasPerPostIds = Array.isArray(ids) && ids.length > 0;
      const matched = assets
        .filter((a) => {
          if (a.tenant_id !== tenantId) return false;
          if (a.orphaned_at !== null) return false;
          if (!USABLE_KINDS.includes(a.storage_kind)) return false;
          if (hasPerPostIds) {
            // Per-post link: asset id or source_asset_id is in the array.
            return ids.includes(a.id) || (a.source_asset_id !== null && ids.includes(a.source_asset_id));
          }
          // Fallback: job-scoped when no per-post ids recorded.
          return post.job_id !== null && a.source_job_id === post.job_id;
        })
        .sort((l, r) => (l.id < r.id ? 1 : -1))
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
function runtimeAsset(
  id: string,
  tenantId: string,
  jobId: string,
  basename: string,
  sourceAssetId: string | null = null,
): AssetRow {
  return {
    id,
    tenant_id: tenantId,
    source_job_id: jobId,
    source_asset_id: sourceAssetId,
    storage_key: `/home/node/.hermes/cache/images/${basename}`,
    storage_kind: 'runtime_asset',
    served_asset_ref: `/api/internal/hermes/media/${basename}`,
    orphaned_at: null,
  };
}

test('resolveMediaUrls is POST-scoped: two posts of one job get only their own asset', async () => {
  // F1 regression: a weekly job produces multiple posts, each with its own
  // image. Scoping by job_id alone returned the whole job's images for any
  // one post. With creative_asset_ids populated, each post resolves to ONLY
  // its own asset.
  const tenantId = '7';
  const posts: PostRow[] = [
    { id: '100', tenant_id: tenantId, job_id: 'job-weekly', creative_asset_ids: ['img_1'] },
    { id: '200', tenant_id: tenantId, job_id: 'job-weekly', creative_asset_ids: ['img_2'] },
  ];
  const assets: AssetRow[] = [
    runtimeAsset('a1', tenantId, 'job-weekly', 'img-one.png', 'img_1'),
    runtimeAsset('a2', tenantId, 'job-weekly', 'img-two.png', 'img_2'),
  ];
  const db = buildFakeDb(posts, assets);

  const urlsA = await resolveMediaUrls('100', tenantId, db);
  assert.equal(urlsA.length, 1, 'post A resolves exactly its own asset');
  assert.ok(urlsA[0].includes('img-one'), `post A must be its own asset only: ${JSON.stringify(urlsA)}`);
  assert.ok(!urlsA.some((u) => u.includes('img-two')), "post A must NOT include post B's asset");

  const urlsB = await resolveMediaUrls('200', tenantId, db);
  assert.equal(urlsB.length, 1, 'post B resolves exactly its own asset');
  assert.ok(urlsB[0].includes('img-two'), 'post B must be its own asset only');
});

test('resolveMediaUrls matches creative_asset_ids against the uuid id too', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [
    { id: '100', tenant_id: tenantId, job_id: 'job-A', creative_asset_ids: ['5ef96782-uuid-asset'] },
  ];
  const assets: AssetRow[] = [
    runtimeAsset('5ef96782-uuid-asset', tenantId, 'job-A', 'by-uuid.png', 'img_1'),
    runtimeAsset('other-uuid', tenantId, 'job-A', 'by-other.png', 'img_2'),
  ];
  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.equal(urls.length, 1, 'only the asset whose uuid id is listed resolves');
  assert.ok(urls[0].includes('by-uuid'), 'matched the uuid-id asset, not the sibling');
});

test('resolveMediaUrls falls back to job-scope when creative_asset_ids is empty', async () => {
  // No Aries code populates creative_asset_ids yet (every prod posts row has
  // '{}'). The job-scoped fallback keeps media resolution working today.
  const tenantId = '7';
  const posts: PostRow[] = [
    { id: '100', tenant_id: tenantId, job_id: 'job-A', creative_asset_ids: [] },
  ];
  const assets: AssetRow[] = [runtimeAsset('a1', tenantId, 'job-A', 'fallback.png', 'img_1')];
  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.equal(urls.length, 1, 'empty creative_asset_ids falls back to the job-scoped join');
  assert.ok(urls[0].includes('fallback'), 'fallback resolves the job asset');
});

test('resolveMediaUrls returns empty when post has no job_id and no per-post ids', async () => {
  const tenantId = '7';
  const posts: PostRow[] = [{ id: '300', tenant_id: tenantId, job_id: null, creative_asset_ids: [] }];
  const assets: AssetRow[] = [runtimeAsset('a1', tenantId, 'job-A', 'img-a1.png', 'img_1')];
  const urls = await resolveMediaUrls('300', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, [], 'no job_id and no per-post ids resolves nothing, never a tenant fallback');
});

test('resolveMediaUrls resolves a runtime_asset row to a non-empty media URL', async () => {
  // Regression for the storage_kind filter bug: runtime_asset is the value
  // Aries-generated images actually carry.
  const tenantId = '7';
  process.env.APP_BASE_URL = 'https://aries.example.test';
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A', creative_asset_ids: [] }];
  const assets: AssetRow[] = [runtimeAsset('a1', tenantId, 'job-A', 'campaign-hero.png', 'img_1')];

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
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    {
      id: 'a1',
      tenant_id: tenantId,
      source_job_id: 'job-A',
      source_asset_id: 'img_1',
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
  const posts: PostRow[] = [{ id: '100', tenant_id: tenantId, job_id: 'job-A', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    {
      id: 'a1',
      tenant_id: tenantId,
      source_job_id: 'job-A',
      source_asset_id: 'img_1',
      storage_key: '/home/node/.hermes/cache/images/orphan.png',
      storage_kind: 'runtime_asset',
      served_asset_ref: null,
      orphaned_at: null,
    },
  ];
  const urls = await resolveMediaUrls('100', tenantId, buildFakeDb(posts, assets));
  assert.deepEqual(urls, [], 'a row with no servable ref is skipped, never served from a host path');
});
