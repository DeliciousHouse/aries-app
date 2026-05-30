import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error — .mjs script imported for its exported pure function.
import { backfillCreativeAssetIds } from '../scripts/backfill-creative-asset-ids.mjs';

type PostRow = { id: string; tenant_id: string; job_id: string | null; creative_asset_ids: string[] | null };
type AssetRow = { tenant_id: string; source_job_id: string; source_type: string; source_asset_id: string | null };

// In-memory fake reproducing the SQL semantics the backfill relies on:
//   - DISTINCT tenant_id for empty-array + job_id rows
//   - candidate posts per tenant (empty-array + job_id)
//   - job's generated_by_aries assets ordered by source_asset_id
//   - UPDATE only when array_length(creative_asset_ids,1) IS NULL (idempotent)
function buildFakeDb(posts: PostRow[], assets: AssetRow[]) {
  const isEmpty = (ids: string[] | null) => !Array.isArray(ids) || ids.length === 0;
  return {
    updates: [] as Array<{ id: string; tenantId: string; value: string[] }>,
    async query(sql: string, params: unknown[] = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.startsWith('SELECT DISTINCT tenant_id')) {
        const seen = new Set<string>();
        for (const p of posts) {
          if (isEmpty(p.creative_asset_ids) && p.job_id) seen.add(p.tenant_id);
        }
        return { rows: [...seen].sort().map((tenant_id) => ({ tenant_id })) };
      }

      if (norm.startsWith('SELECT id, job_id')) {
        const [tenantId] = params as [string];
        const rows = posts
          .filter((p) => p.tenant_id === tenantId && isEmpty(p.creative_asset_ids) && p.job_id)
          .map((p) => ({ id: p.id, job_id: p.job_id }));
        return { rows };
      }

      if (norm.startsWith('SELECT source_asset_id')) {
        const [tenantId, jobId] = params as [string, string];
        const rows = assets
          .filter(
            (a) =>
              a.tenant_id === tenantId &&
              a.source_job_id === jobId &&
              a.source_type === 'generated_by_aries' &&
              a.source_asset_id !== null,
          )
          .sort((l, r) => (l.source_asset_id! < r.source_asset_id! ? -1 : 1))
          .map((a) => ({ source_asset_id: a.source_asset_id }));
        return { rows };
      }

      if (norm.startsWith('UPDATE posts')) {
        const [id, tenantId, assetId] = params as [string, string, string];
        const post = posts.find((p) => p.id === id && p.tenant_id === tenantId);
        // Idempotency guard: only writes when array_length IS NULL (empty).
        if (post && isEmpty(post.creative_asset_ids)) {
          post.creative_asset_ids = [assetId];
          this.updates.push({ id, tenantId, value: [assetId] });
        }
        return { rows: [] };
      }

      throw new Error(`unexpected query: ${norm}`);
    },
  };
}

const silent = () => {};

test('backfill: single-asset legacy row is populated with the job asset', async () => {
  const posts: PostRow[] = [{ id: 'p1', tenant_id: 't1', job_id: 'job-a', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    { tenant_id: 't1', source_job_id: 'job-a', source_type: 'generated_by_aries', source_asset_id: 'img_1' },
  ];
  const db = buildFakeDb(posts, assets);
  const counts = await backfillCreativeAssetIds(db, { write: true, log: silent });

  assert.equal(counts.populated, 1);
  assert.equal(counts.ambiguousMulti, 0);
  assert.equal(counts.empty, 0);
  assert.deepEqual(posts[0].creative_asset_ids, ['img_1']);
  assert.equal(db.updates.length, 1);
});

test('backfill: multi-asset legacy row is AMBIGUOUS — counted and untouched', async () => {
  const posts: PostRow[] = [{ id: 'p1', tenant_id: 't1', job_id: 'job-multi', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    { tenant_id: 't1', source_job_id: 'job-multi', source_type: 'generated_by_aries', source_asset_id: 'img_1' },
    { tenant_id: 't1', source_job_id: 'job-multi', source_type: 'generated_by_aries', source_asset_id: 'img_2' },
  ];
  const db = buildFakeDb(posts, assets);
  const counts = await backfillCreativeAssetIds(db, { write: true, log: silent });

  assert.equal(counts.ambiguousMulti, 1);
  assert.equal(counts.populated, 0);
  assert.deepEqual(posts[0].creative_asset_ids, [], 'ambiguous row is left on the fallback');
  assert.equal(db.updates.length, 0);
});

test('backfill: job with zero assets is counted empty and left untouched', async () => {
  const posts: PostRow[] = [{ id: 'p1', tenant_id: 't1', job_id: 'job-empty', creative_asset_ids: [] }];
  const db = buildFakeDb(posts, []);
  const counts = await backfillCreativeAssetIds(db, { write: true, log: silent });

  assert.equal(counts.empty, 1);
  assert.equal(counts.populated, 0);
  assert.deepEqual(posts[0].creative_asset_ids, []);
});

test('backfill: dry-run computes counts without writing', async () => {
  const posts: PostRow[] = [{ id: 'p1', tenant_id: 't1', job_id: 'job-a', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    { tenant_id: 't1', source_job_id: 'job-a', source_type: 'generated_by_aries', source_asset_id: 'img_1' },
  ];
  const db = buildFakeDb(posts, assets);
  const counts = await backfillCreativeAssetIds(db, { write: false, log: silent });

  assert.equal(counts.populated, 1, 'dry-run still reports what it would populate');
  assert.deepEqual(posts[0].creative_asset_ids, [], 'dry-run does not mutate the row');
  assert.equal(db.updates.length, 0);
});

test('backfill: re-running after a write is a no-op (idempotent)', async () => {
  const posts: PostRow[] = [{ id: 'p1', tenant_id: 't1', job_id: 'job-a', creative_asset_ids: [] }];
  const assets: AssetRow[] = [
    { tenant_id: 't1', source_job_id: 'job-a', source_type: 'generated_by_aries', source_asset_id: 'img_1' },
  ];
  const db = buildFakeDb(posts, assets);

  await backfillCreativeAssetIds(db, { write: true, log: silent });
  const second = await backfillCreativeAssetIds(db, { write: true, log: silent });

  assert.equal(second.total, 0, 'no candidate rows remain — already populated');
  assert.equal(second.populated, 0);
  assert.equal(db.updates.length, 1, 'no second write');
});

test('backfill: queries are tenant-scoped — a tenant filter only touches its own rows', async () => {
  const posts: PostRow[] = [
    { id: 'p1', tenant_id: 't1', job_id: 'job-a', creative_asset_ids: [] },
    { id: 'p2', tenant_id: 't2', job_id: 'job-b', creative_asset_ids: [] },
  ];
  const assets: AssetRow[] = [
    { tenant_id: 't1', source_job_id: 'job-a', source_type: 'generated_by_aries', source_asset_id: 'img_1' },
    { tenant_id: 't2', source_job_id: 'job-b', source_type: 'generated_by_aries', source_asset_id: 'img_9' },
  ];
  const db = buildFakeDb(posts, assets);
  const counts = await backfillCreativeAssetIds(db, { write: true, tenantFilter: 't1', log: silent });

  assert.equal(counts.tenants, 1);
  assert.equal(counts.populated, 1);
  assert.deepEqual(posts[0].creative_asset_ids, ['img_1']);
  assert.deepEqual(posts[1].creative_asset_ids, [], 't2 untouched under a t1 filter');
});
