import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestProductionCreativeAssetsToDb } from '../../backend/marketing/ingest-production-assets';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Minimal runtime document factory
// ---------------------------------------------------------------------------

function makeDoc(overrides: {
  jobId?: string;
  tenantId?: string;
  creativeAssets?: unknown[];
}): SocialContentJobRuntimeDocument {
  const jobId = overrides.jobId ?? 'mkt_test_job_id';
  const creativeAssets = overrides.creativeAssets ?? [];
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: overrides.tenantId ?? '42',
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: {
        stage: 'research',
        status: 'completed',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: null,
        summary: null,
        primary_output: null,
        outputs: {},
        artifacts: [],
        errors: [],
      },
      strategy: {
        stage: 'strategy',
        status: 'completed',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: null,
        summary: null,
        primary_output: null,
        outputs: {},
        artifacts: [],
        errors: [],
      },
      production: {
        stage: 'production',
        status: 'completed',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: null,
        summary: null,
        primary_output: {
          artifacts: {
            creative_assets: creativeAssets,
          },
        },
        outputs: {},
        artifacts: [],
        errors: [],
      },
      publish: {
        stage: 'publish',
        status: 'not_started',
        started_at: null,
        completed_at: null,
        failed_at: null,
        run_id: null,
        summary: null,
        primary_output: null,
        outputs: {},
        artifacts: [],
        errors: [],
      },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

// ---------------------------------------------------------------------------
// Mock pool builder
// ---------------------------------------------------------------------------

type QueryCall = { sql: string; params: unknown[] };

function makeMockPool(rowCount = 1) {
  const calls: QueryCall[] = [];
  const pool = {
    query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: rowCount > 0 ? [{ id: 'uuid-1' }] : [], rowCount });
    },
  };
  return { pool, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('ingestProductionCreativeAssetsToDb — returns zero counts when production.primary_output is null', async () => {
  const doc = makeDoc({});
  (doc.stages.production as Record<string, unknown>).primary_output = null;
  const { pool } = makeMockPool();
  const result = await ingestProductionCreativeAssetsToDb({
    jobId: 'mkt_no_output',
    tenantId: 42,
    doc,
    pool,
  });
  assert.deepEqual(result, { inserted: 0, skipped: 0, total: 0 });
});

test('ingestProductionCreativeAssetsToDb — returns zero counts when creative_assets array is absent', async () => {
  const doc = makeDoc({});
  (doc.stages.production.primary_output as Record<string, unknown>) = { artifacts: {} };
  const { pool } = makeMockPool();
  const result = await ingestProductionCreativeAssetsToDb({
    jobId: 'mkt_no_assets',
    tenantId: 42,
    doc,
    pool,
  });
  assert.deepEqual(result, { inserted: 0, skipped: 0, total: 0 });
});

// ---------------------------------------------------------------------------
// Hermes media mount harness
//
// Production reality: Hermes reports `creative_assets[].path` as a HOST path
// (e.g. /home/node/.hermes/profiles/<profile>/cache/images/x.png) that the
// Aries container CANNOT read. The container can only read the image cache via
// the HERMES_IMAGE_CACHE_MOUNT bind-mount, keyed by basename. Each test sets up
// a temp dir to act as that mount and points HERMES_IMAGE_CACHE_MOUNT at it.
// ---------------------------------------------------------------------------

async function withHermesMediaMount<T>(
  fn: (mount: string, hostImagePath: (basename: string) => string) => Promise<T>,
): Promise<T> {
  const mount = path.join(tmpdir(), `aries-hermes-media-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(mount, { recursive: true });
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  // A Hermes host path the container never has on disk — the regression vector.
  const hostImagePath = (basename: string) =>
    `/home/node/.hermes/profiles/aries-content-generator/cache/images/${basename}`;
  try {
    return await fn(mount, hostImagePath);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    await rm(mount, { recursive: true, force: true });
  }
}

test('ingestProductionCreativeAssetsToDb — skips entries with empty path', async () => {
  await withHermesMediaMount(async () => {
    const doc = makeDoc({
      creativeAssets: [
        { assetId: 'a1', type: 'generated_image', path: '' },
        { assetId: 'a2', type: 'generated_image' },
      ],
    });
    const { pool, calls } = makeMockPool();
    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_empty_path',
      tenantId: 42,
      doc,
      pool,
    });
    assert.equal(result.total, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.inserted, 0);
    assert.equal(calls.length, 0, 'No DB calls should be made for entries with empty path');
  });
});

// REGRESSION: publish-ingestion bug. Hermes reports a host-side path the Aries
// container cannot read; the image is only reachable via the mount by basename.
// Before the fix, ingest readFile()'d the raw host path -> ENOENT -> 0 rows
// inserted -> "Generated assets 0 / No launch items" in the operator dashboard.
test('ingestProductionCreativeAssetsToDb — resolves Hermes host path via mount by basename', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'openai_codex_gpt-image-2-low_20260521_012107_1aeff6b2.png';
    // The file exists ONLY at <mount>/<basename> — never at the reported host path.
    await writeFile(path.join(mount, basename), Buffer.from('fakepngdata'));

    const doc = makeDoc({
      creativeAssets: [
        {
          assetId: 'img_1',
          type: 'generated_image',
          // The exact path shape Hermes emits post three-profile routing.
          path: hostImagePath(basename),
          prompt: 'test prompt',
        },
      ],
    });
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_f5f8464b',
      tenantId: 15,
      doc,
      pool,
    });

    assert.equal(result.total, 1);
    assert.equal(result.inserted, 1, 'image reachable via mount must be ingested');
    assert.equal(result.skipped, 0);
    assert.equal(calls.length, 1, 'the resolved row must reach the DB');

    const { sql, params } = calls[0];
    assert.equal(params[2], 'img_1', 'source_asset_id preserved');
    // served_asset_ref is id-based, built in the INSERT from the row's OWN
    // subselect-generated id (g.id) — NOT a data-modifying CTE, whose outer
    // UPDATE runs on a pre-INSERT snapshot and silently leaves the ref NULL
    // (the #517 regression). It must never reintroduce the `ins.id` CTE form.
    assert.ok(
      sql.includes("'/api/internal/hermes/media/' || g.id::text"),
      'served_asset_ref must be built in the INSERT from the subselect id (g.id)',
    );
    assert.ok(
      !/WITH\s+ins\s+AS/i.test(sql),
      'must NOT use the data-modifying CTE form that leaves served_asset_ref NULL',
    );
    assert.equal(
      params[3],
      path.join(mount, basename),
      'storage_key must be the readable mount path, not the unreadable host path',
    );
    assert.ok(typeof params[4] === 'string' && (params[4] as string).length === 64, 'checksum sha256 hex');
  });
});

test('ingestProductionCreativeAssetsToDb — inserts row with correct SQL shape', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'openai_codex_abc123.png';
    await writeFile(path.join(mount, basename), Buffer.from('fakepngdata'));

    const doc = makeDoc({
      creativeAssets: [
        {
          assetId: 'asset-001',
          type: 'generated_image',
          path: hostImagePath(basename),
          prompt: 'test prompt',
          placement: 'feed',
        },
      ],
    });
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_insert_test',
      tenantId: 99,
      doc,
      pool,
    });

    assert.equal(result.total, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 0);
    assert.equal(calls.length, 1);

    const { sql, params } = calls[0];

    // Assert the INSERT shape and ON CONFLICT clause
    assert.ok(sql.includes('INSERT INTO creative_assets'), 'SQL must INSERT INTO creative_assets');
    // The ON CONFLICT must repeat the partial unique index predicate
    // (`WHERE checksum IS NOT NULL`) or Postgres rejects every INSERT. That it
    // actually runs against real Postgres is covered by the live-DB test.
    assert.ok(
      sql.includes("ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL DO NOTHING"),
      'SQL must have ON CONFLICT with the partial-index predicate',
    );
    // served_asset_ref is id-based, built in the INSERT from the row's OWN
    // subselect-generated id (g.id). The data-modifying CTE form leaves it NULL
    // (the #517 regression) — guard against its reintroduction.
    assert.ok(
      sql.includes("'/api/internal/hermes/media/' || g.id::text"),
      'served_asset_ref must be built in the INSERT from the subselect id (g.id)',
    );
    assert.ok(
      !/WITH\s+ins\s+AS/i.test(sql),
      'must NOT use the data-modifying CTE form that leaves served_asset_ref NULL',
    );
    assert.ok(sql.includes("'generated_by_aries'"), 'source_type must be generated_by_aries');
    assert.ok(sql.includes("'runtime_asset'"), 'storage_kind must be runtime_asset');
    assert.ok(sql.includes("'generated'"), 'permission_scope must be generated');
    assert.ok(sql.includes("'image'"), 'media_type must be image');
    assert.ok(sql.includes("'4:5'"), 'aspect_ratio must be 4:5');

    // params: [tenantId, jobId, sourceAssetId, storagePath, checksum]
    assert.equal(params[0], 99, 'param $1 must be tenantId');
    assert.equal(params[1], 'mkt_insert_test', 'param $2 must be jobId');
    assert.equal(params[2], 'asset-001', 'param $3 must be sourceAssetId');
    assert.equal(params[3], path.join(mount, basename), 'param $4 must be the readable mount storagePath');
    assert.ok(typeof params[4] === 'string' && (params[4] as string).length === 64, 'param $5 must be a sha256 hex string');
  });
});

test('ingestProductionCreativeAssetsToDb — skips when HERMES_IMAGE_CACHE_MOUNT is unset', async () => {
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  delete process.env.HERMES_IMAGE_CACHE_MOUNT;
  try {
    const doc = makeDoc({
      creativeAssets: [
        {
          assetId: 'img_1',
          type: 'generated_image',
          path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/x.png',
        },
      ],
    });
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_no_mount',
      tenantId: 1,
      doc,
      pool,
    });
    assert.equal(result.total, 1);
    assert.equal(result.skipped, 1, 'unresolvable path must be skipped, not crash');
    assert.equal(result.inserted, 0);
    assert.equal(calls.length, 0, 'no DB call when path cannot be resolved');
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
  }
});

test('ingestProductionCreativeAssetsToDb — ON CONFLICT: rowCount=0 counts as skipped', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'openai_gpt_dup.png';
    await writeFile(path.join(mount, basename), Buffer.from('dupdata'));

    const doc = makeDoc({
      creativeAssets: [{ assetId: 'dup-asset', type: 'generated_image', path: hostImagePath(basename) }],
    });
    const { pool } = makeMockPool(0);
    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_conflict_test',
      tenantId: 5,
      doc,
      pool,
    });

    assert.equal(result.total, 1);
    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, 1, 'rowCount=0 (conflict) must count as skipped');
  });
});

test('ingestProductionCreativeAssetsToDb — per-row error does not fail the batch', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const goodBasename = 'openai_codex_good.png';
    await writeFile(path.join(mount, goodBasename), Buffer.from('gooddata'));
    // bad: a basename with no corresponding file under the mount.
    const badBasename = 'openai_codex_bad.png';

    const doc = makeDoc({
      creativeAssets: [
        { assetId: 'bad-asset', type: 'generated_image', path: hostImagePath(badBasename) },
        { assetId: 'good-asset', type: 'generated_image', path: hostImagePath(goodBasename) },
      ],
    });
    const { pool, calls } = makeMockPool(1);

    const result = await ingestProductionCreativeAssetsToDb({
      jobId: 'mkt_error_test',
      tenantId: 7,
      doc,
      pool,
    });

    assert.equal(result.total, 2);
    assert.equal(result.skipped, 1, 'bad row must be skipped');
    assert.equal(result.inserted, 1, 'good row must be inserted');
    assert.equal(calls.length, 1, 'Only the good row should reach the DB');
  });
});
