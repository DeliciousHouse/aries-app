#!/usr/bin/env node
/*
 * Backfill: populate `posts.creative_asset_ids` for legacy rows.
 *
 * `posts.creative_asset_ids` (TEXT[]) is the per-post media link that lets the
 * scheduled-dispatch resolver pick the *exact* image for a post instead of
 * falling back to a job-scoped join that returns every image the weekly job
 * produced. The publish/synthesize writers now populate it on every new row,
 * but rows written before those writers landed are still '{}' and rely on the
 * fallback — a multi-image job can publish the wrong creative.
 *
 * This one-shot pass fills `creative_asset_ids` for every post that has an empty
 * array AND a `job_id`, using the job's generated `creative_assets`:
 *
 *   - exactly one asset for the job  -> set ARRAY[<that asset's source_asset_id>]
 *     (non-regressive vs the current fallback, and now exact).
 *   - more than one asset for the job -> AMBIGUOUS (legacy rows carry no
 *     post_number, so the post->asset mapping is unknowable). Do NOT guess:
 *     log + count, leave the row on the fallback.
 *
 * Idempotent: only touches rows where `array_length(creative_asset_ids, 1) IS
 * NULL`, so re-running is a no-op. Never deletes ids.
 *
 * Tenant-scoped + sequential per tenant (guardrail #1: no Promise.all fan-out
 * over the pool). Dry-run by default.
 *
 * NOT wired into init-db.js (D5: schema migrations only). Run manually:
 *   node scripts/backfill-creative-asset-ids.mjs              # dry-run (default)
 *   node scripts/backfill-creative-asset-ids.mjs --write      # persist changes
 *   node scripts/backfill-creative-asset-ids.mjs --tenant t1  # limit to one tenant
 */

import process from 'node:process';

/**
 * Core backfill, decoupled from the pg pool so it is unit-testable with a mock
 * queryable. `db` only needs a `.query(sql, params)` returning `{ rows }`.
 *
 * Returns aggregate counts: { tenants, total, populated, empty, ambiguousMulti }.
 *   total           — empty-array rows with a job_id considered (the candidates)
 *   populated       — single-asset rows set (or that would be set in dry-run)
 *   empty           — candidate rows whose job produced zero usable assets
 *   ambiguousMulti  — multi-asset rows left on the fallback (untouched)
 */
export async function backfillCreativeAssetIds(db, { write = false, tenantFilter = null, log = console.log } = {}) {
  const counts = { tenants: 0, total: 0, populated: 0, empty: 0, ambiguousMulti: 0 };

  const tenantRows = tenantFilter
    ? [{ tenant_id: tenantFilter }]
    : (
        await db.query(
          `SELECT DISTINCT tenant_id
             FROM posts
            WHERE array_length(creative_asset_ids, 1) IS NULL
              AND job_id IS NOT NULL
            ORDER BY tenant_id`,
        )
      ).rows;

  for (const { tenant_id: tenantId } of tenantRows) {
    counts.tenants += 1;

    // Candidate posts: empty creative_asset_ids + a job_id, scoped to tenant.
    const posts = (
      await db.query(
        `SELECT id, job_id
           FROM posts
          WHERE tenant_id = $1
            AND array_length(creative_asset_ids, 1) IS NULL
            AND job_id IS NOT NULL
          ORDER BY id`,
        [tenantId],
      )
    ).rows;

    for (const post of posts) {
      counts.total += 1;

      // The job's generated assets, ordered by source_asset_id (img_1, img_2, ..).
      const assets = (
        await db.query(
          `SELECT source_asset_id
             FROM creative_assets
            WHERE tenant_id = $1
              AND source_job_id = $2
              AND source_type = 'generated_by_aries'
              AND source_asset_id IS NOT NULL
            ORDER BY source_asset_id`,
          [tenantId, post.job_id],
        )
      ).rows;

      if (assets.length === 0) {
        counts.empty += 1;
        log(`[backfill] tenant=${tenantId} post=${post.id} job=${post.job_id}: 0 assets — left on fallback`);
        continue;
      }

      if (assets.length > 1) {
        counts.ambiguousMulti += 1;
        log(
          `[backfill] tenant=${tenantId} post=${post.id} job=${post.job_id}: ${assets.length} assets — AMBIGUOUS (no post_number), left on fallback`,
        );
        continue;
      }

      const assetId = assets[0].source_asset_id;
      counts.populated += 1;
      if (write) {
        await db.query(
          `UPDATE posts
              SET creative_asset_ids = ARRAY[$3]::text[]
            WHERE id = $1
              AND tenant_id = $2
              AND array_length(creative_asset_ids, 1) IS NULL`,
          [post.id, tenantId, assetId],
        );
        log(`[backfill] tenant=${tenantId} post=${post.id} job=${post.job_id}: set creative_asset_ids = {${assetId}}`);
      } else {
        log(`[backfill] tenant=${tenantId} post=${post.id} job=${post.job_id}: would set creative_asset_ids = {${assetId}}`);
      }
    }
  }

  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const tenantIdx = args.indexOf('--tenant');
  const tenantFilter = tenantIdx >= 0 ? args[tenantIdx + 1] : null;

  console.log(`[backfill] mode = ${write ? 'WRITE' : 'dry-run'}`);
  if (tenantFilter) console.log(`[backfill] tenant filter = ${tenantFilter}`);

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    const counts = await backfillCreativeAssetIds(pool, { write, tenantFilter });
    console.log('[backfill] ---- report ----');
    console.log(`[backfill]   tenants scanned    : ${counts.tenants}`);
    console.log(`[backfill]   candidate rows      : ${counts.total}`);
    console.log(`[backfill]   populated (1 asset) : ${counts.populated}${write ? '' : ' (dry-run)'}`);
    console.log(`[backfill]   empty (0 assets)    : ${counts.empty}`);
    console.log(`[backfill]   ambiguous (N>1)     : ${counts.ambiguousMulti} (left on fallback)`);
    if (!write && counts.populated > 0) {
      console.log('[backfill] rerun with --write to persist changes.');
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
}
