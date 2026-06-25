/**
 * Tests for the B1 dashboard safety net (Part B1).
 *
 * Verifies:
 *   1. A job whose publish-stage payload is strategy-shaped (empty posts/assets)
 *      but has DB rows → dashboard supplements assets + non-zero counts.
 *   2. A healthy job with a real publish payload AND DB rows → no double-count
 *      (B1 gate is not entered, payload-derived output is unchanged).
 *   3. Projection staleness → after synthesize/ingest writes posts+assets, the
 *      recompute in synthesizePublishPostsOnCompletion refreshes the projection.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/publish-stage-decoupling-b1.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Mock pool factory — returns DB creative_assets + posts data without a
// real Postgres connection.
// ---------------------------------------------------------------------------

type MockAsset = { id: string; source_asset_id: string | null; served_asset_ref: string | null; media_type?: string };
type MockPostCount = { published_status: string; cnt: string };

function installMockPool(opts: {
  assets: MockAsset[];
  postCounts: MockPostCount[];
}): { calls: Array<{ sql: string; params: unknown[] }>; restore: () => void } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
  const prev = g.__ariesPgPool;

  g.__ariesPgPool = {
    query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/FROM\s+creative_assets/i.test(sql)) {
        return Promise.resolve({ rows: opts.assets, rowCount: opts.assets.length });
      }
      if (/FROM\s+posts[\s\S]*GROUP\s+BY\s+published_status/i.test(sql)) {
        return Promise.resolve({ rows: opts.postCounts, rowCount: opts.postCounts.length });
      }
      // Default: return empty
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Pool;

  return {
    calls,
    restore: () => {
      g.__ariesPgPool = prev;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create a minimal runtime doc and write it to DATA_ROOT
// ---------------------------------------------------------------------------

async function setupDoc(dataRoot: string, jobId: string, tenantId: string, publishOutput: unknown) {
  const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } =
    await import('../../backend/marketing/runtime-state');

  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'coaching',
      competitorUrl: '',
      imageCreativeCount: 1,
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'clear',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });

  // Mark all pipeline stages completed so publishArtifactsAvailable returns true
  doc.stages.strategy.status = 'completed';
  doc.stages.production.status = 'completed';
  doc.stages.publish.status = 'completed';
  doc.stages.publish.primary_output = publishOutput as Record<string, unknown>;
  doc.state = 'completed';
  doc.status = 'completed';
  doc.current_stage = 'publish';

  saveSocialContentJobRuntime(jobId, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Test 1: strategy-shaped payload + DB rows → B1 supplements assets + counts
// ---------------------------------------------------------------------------

test('B1: strategy-shaped publish payload + DB assets → dashboard returns DB assets + non-zero counts', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-b1-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  const { restore } = installMockPool({
    assets: [
      { id: 'uuid-img-1', source_asset_id: 'img_1', served_asset_ref: '/api/internal/hermes/media/uuid-img-1', media_type: 'image' },
      { id: 'uuid-img-2', source_asset_id: 'img_2', served_asset_ref: '/api/internal/hermes/media/uuid-img-2', media_type: 'image' },
    ],
    postCounts: [
      { published_status: 'approved', cnt: '7' },
    ],
  });

  try {
    const jobId = `mkt_b1_test_${dataRoot.slice(-6)}`;
    await setupDoc(dataRoot, jobId, '15', {
      // Strategy-shaped placeholder: has stage:'strategy', no posts/schedule
      stage: 'strategy',
      content_package: [{ post_number: 1, platforms: ['instagram', 'facebook'] }],
    });

    const { getMarketingDashboardSocialContentJobContent } = await import('../../backend/marketing/dashboard-content');
    const content = await getMarketingDashboardSocialContentJobContent(jobId);

    // B1 should supplement: DB has 2 assets, 7 approved posts
    assert.ok(
      content.assets.length >= 2,
      `expected ≥2 DB-supplemented assets, got ${content.assets.length}`,
    );
    // Preview URLs should point to the hermes media route
    const assetWithPreview = content.assets.find((a) => a.previewUrl?.includes('/api/internal/hermes/media/'));
    assert.ok(assetWithPreview, `expected at least one asset with hermes preview URL, got: ${JSON.stringify(content.assets.map(a => a.previewUrl))}`);

    // counts.posts reflects DB count
    const job = content.post;
    assert.ok(job, 'expected a socialContentJob');
    assert.equal(job.counts.posts, 7, `expected counts.posts=7 (from DB), got ${job.counts.posts}`);
    assert.equal(job.counts.readyToPublish, 7, `expected counts.readyToPublish=7 (from DB approved), got ${job.counts.readyToPublish}`);
  } finally {
    restore();
    delete process.env.DATA_ROOT;
    delete process.env.APP_BASE_URL;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: healthy publish payload → no double-count (B1 gate not entered)
// ---------------------------------------------------------------------------

test('B1 gate: healthy publish payload with posts+assets → no DB supplementation, payload-only output', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-b1-healthy-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  const dbCalls: Array<{ sql: string }> = [];
  const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
  const prevPool = g.__ariesPgPool;

  g.__ariesPgPool = {
    query(sql: string) {
      dbCalls.push({ sql });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Pool;

  try {
    const jobId = `mkt_b1_healthy_${dataRoot.slice(-6)}`;

    // Write a doc with a real publish-shaped primary_output (posts + schedule).
    // dashboard-content will find post candidates from that payload → B1 gate NOT entered.
    await setupDoc(dataRoot, jobId, '15', {
      stage: 'publish',
      posts: [
        { post_number: 1, platforms: ['instagram'], caption: 'Test post', hashtags: [] },
      ],
      schedule: [
        { post_number: 1, recommended_day: 'Monday', platforms: ['instagram'] },
      ],
      platform_strategy: { instagram: { audience: 'test' } },
    });

    const { getMarketingDashboardSocialContentJobContent } = await import('../../backend/marketing/dashboard-content');
    await getMarketingDashboardSocialContentJobContent(jobId);

    // The B1 supplementation queries are:
    //   1) SELECT ... FROM creative_assets WHERE ...
    //   2) SELECT published_status, COUNT(*) FROM posts GROUP BY published_status
    // A healthy payload job has posts/assets from the payload → B1 gate NOT entered
    // → neither supplementation query should fire (only the outer creative_assets
    //    query from workspace-views.ts is expected, NOT the B1 posts-count query).
    const b1PostsCountQuery = dbCalls.some((c) => /GROUP\s+BY\s+published_status/i.test(c.sql));
    assert.equal(b1PostsCountQuery, false, `B1 posts-count query must NOT fire for healthy payload. SQLs: ${dbCalls.map(c => c.sql.replace(/\s+/g, ' ').slice(0, 80)).join(' | ')}`);
  } finally {
    g.__ariesPgPool = prevPool;
    delete process.env.DATA_ROOT;
    delete process.env.APP_BASE_URL;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: projection staleness — recompute in synthesizePublishPostsOnCompletion
// refreshes the projection so the B1 safety net path is reflected.
// ---------------------------------------------------------------------------

test('B1 projection: recompute fires inside synthesizePublishPostsOnCompletion', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-b1-proj-'));
  const prev: Record<string, string | undefined> = {
    DATA_ROOT: process.env.DATA_ROOT,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ARIES_AUTO_APPROVE_MARKETING_PIPELINE: process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE,
    ARIES_AUTOSCHEDULE_ON_APPROVAL: process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL,
  };

  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '0';
  process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL = '0';

  const sqls: string[] = [];
  let restorePool: (() => void) | null = null;

  try {
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } =
      await import('../../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const poolMod = await import('../../lib/db');
    const pool = poolMod.default;

    const origQuery = pool.query.bind(pool);
    restorePool = () => {
      (pool as { query: typeof origQuery }).query = origQuery;
    };
    (pool as { query: unknown }).query = async (sql: unknown, params: unknown[] = []) => {
      sqls.push(String(sql));
      // Return minimal data so synthesizePublishPostsFromContentPackage can run
      if (/FROM\s+posts/i.test(String(sql))) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM\s+creative_assets/i.test(String(sql))) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ id: 1 }], rowCount: 1 };
    };

    const jobId = `mkt_b1_proj_${dataRoot.slice(-6)}`;
    const doc = createSocialContentJobRuntimeDocument({
      jobId,
      tenantId: '999',
      payload: { brandUrl: 'https://brand.example', businessType: 'coaching', competitorUrl: '', imageCreativeCount: 1 },
      brandKit: {
        path: '/tmp/brand-kit.json', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
        brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [], external_links: [], extracted_at: new Date().toISOString(), brand_voice_summary: 'clear',
        offer_summary: null, positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(jobId, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes', domain: 'marketing', workflowKey: 'social_content_weekly', action: 'resume',
      tenantId: doc.tenant_id, marketingJobId: jobId, stage: 'publish',
    });

    // Trigger the publish completion callback with a strategy-shaped placeholder
    await handleHermesRunCallback({
      event_id: `evt-b1-proj-${dataRoot.slice(-6)}`,
      aries_run_id: run.aries_run_id,
      hermes_run_id: `hermes-b1-proj-${dataRoot.slice(-6)}`,
      status: 'completed',
      stage: 'publish',
      output: [{ stage: 'strategy', content_package: [] }],
    });

    // The projection recompute inside synthesizePublishPostsOnCompletion must
    // query creative_assets (the workspace-views.ts call inside buildSocialContentWorkspaceView).
    // This proves the recompute fired after the posts+assets were written.
    const creativeAssetsQueried = sqls.some((s) => /FROM\s+creative_assets/i.test(s));
    assert.ok(
      creativeAssetsQueried,
      `projection recompute must query creative_assets. SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 80)).join(' | ')}`,
    );
  } finally {
    if (restorePool) restorePool();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
});
