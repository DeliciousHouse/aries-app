/**
 * Slice 5 — workspace-views production-asset DB merge maps video rows to
 * contentType:'video/mp4' and title:'Generated Video'.
 *
 * Uses the globalThis.__ariesPgPool seam (same pattern as
 * pending-approval-count-denorm.test.ts) to inject a mock pool so the test
 * runs without a live database.
 *
 * IMPORTANT: lib/db.ts captures the pool const ONCE at module load time, so
 * __ariesPgPool must be set BEFORE the first dynamic import of workspace-views
 * or lib/db. We use a SINGLE mutable-state pool installed at file initialisation
 * time; each test sets _currentRows before calling buildSocialContentWorkspaceView.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/workspace-video-asset-mapping.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

// TYPE-only imports — erased at compile time, do NOT trigger lib/db.ts to load.
import type { Pool } from 'pg';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

import { resolveProjectRoot } from '../helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// ---------------------------------------------------------------------------
// Mutable-state global pool — installed ONCE before lib/db.ts first loads.
// Each test updates _currentRows; the pool dispatches from that variable.
// This works around the "pool const captured once" constraint in lib/db.ts.
// ---------------------------------------------------------------------------

let _currentRows: Array<Record<string, unknown>> = [];

const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
g.__ariesPgPool = {
  query(sql: string) {
    if (/SELECT[\s\S]*FROM creative_assets/i.test(sql)) {
      return Promise.resolve({ rows: _currentRows, rowCount: _currentRows.length });
    }
    // Posts query and any other query — return empty.
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
} as unknown as Pool;

// ---------------------------------------------------------------------------
// Runtime doc factory — minimal doc with numeric tenant_id so queryProductionCreativeAssets
// proceeds past its tenantNum guard.
// ---------------------------------------------------------------------------

function makeMinimalDoc(jobId: string): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: '42',  // Number('42') = 42 > 0 → passes guard
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: { artifacts: { creative_assets: [] } }, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
    created_at: '2026-06-23T00:00:00.000Z', updated_at: '2026-06-23T00:00:00.000Z',
  } as unknown as SocialContentJobRuntimeDocument;
}

async function withEnv<T>(rows: Array<Record<string, unknown>>, run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevData = process.env.DATA_ROOT;
  const prevCode = process.env.CODE_ROOT;
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-ws-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = dataRoot;
  _currentRows = rows;  // configure the shared pool for this test
  try {
    return await run(dataRoot);
  } finally {
    _currentRows = [];
    if (prevData === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevData;
    if (prevCode === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCode;
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

// Import buildSocialContentWorkspaceView ONCE via before() hook.
// lib/db.ts loads during this import and captures the shared mutable pool above.
// __ariesPgPool is already set at module level before this before() runs.
let buildSocialContentWorkspaceView: Awaited<typeof import('../../backend/marketing/workspace-views')>['buildSocialContentWorkspaceView'];

before(async () => {
  const mod = await import('../../backend/marketing/workspace-views');
  buildSocialContentWorkspaceView = mod.buildSocialContentWorkspaceView;
});

// ---------------------------------------------------------------------------
// Slice 5 — workspace-views production-asset merge
// ---------------------------------------------------------------------------

test('video DB row maps to contentType:video/mp4 and title:Generated Video', async () => {
  // FAIL BEFORE: media_type was not SELECTed, so isVideo=false → contentType:'image/png'
  // PASS AFTER:  media_type is SELECTed; isVideo=true → contentType:'video/mp4'
  await withEnv([
    {
      id: 'uuid-vid-1',
      source_asset_id: 'vid_1',
      served_asset_ref: '/api/internal/hermes/media/uuid-vid-1',
      checksum: 'abc123',
      media_type: 'video',
      aspect_ratio: '9:16',
      width_px: 1080,
      height_px: 1920,
      duration_seconds: 15,
    },
  ], async () => {
    const jobId = 'mkt_video_ws_test';
    const view = await buildSocialContentWorkspaceView(jobId, {
      runtimeDoc: makeMinimalDoc(jobId),
    });

    const assets = view.creativeReview?.assets ?? [];
    assert.ok(assets.length > 0, 'video asset must appear in creativeReview.assets');

    const videoAsset = assets.find((a) => a.assetId === 'vid_1');
    assert.ok(videoAsset, 'vid_1 asset must be present');
    assert.equal(videoAsset!.contentType, 'video/mp4', 'video row must map to contentType:video/mp4');
    assert.equal(videoAsset!.title, 'Generated Video', 'video row must map to title:Generated Video');
    assert.equal(videoAsset!.previewUrl, '/api/internal/hermes/media/uuid-vid-1', 'served_asset_ref threaded as previewUrl');
  });
});

test('image DB row still maps to contentType:image/png and title:Generated Image', async () => {
  await withEnv([
    {
      id: 'uuid-img-1',
      source_asset_id: 'img_1',
      served_asset_ref: '/api/internal/hermes/media/uuid-img-1',
      checksum: 'def456',
      media_type: 'image',
      aspect_ratio: '4:5',
      width_px: null,
      height_px: null,
      duration_seconds: null,
    },
  ], async () => {
    const jobId = 'mkt_img_ws_test';
    const view = await buildSocialContentWorkspaceView(jobId, {
      runtimeDoc: makeMinimalDoc(jobId),
    });

    const assets = view.creativeReview?.assets ?? [];
    const imageAsset = assets.find((a) => a.assetId === 'img_1');
    assert.ok(imageAsset, 'img_1 asset must be present');
    assert.equal(imageAsset!.contentType, 'image/png', 'image row must stay contentType:image/png');
    assert.equal(imageAsset!.title, 'Generated Image', 'image row must stay title:Generated Image');
  });
});

test('null media_type row defaults to image (not video)', async () => {
  await withEnv([
    {
      id: 'uuid-null-1',
      source_asset_id: 'null_asset',
      served_asset_ref: '/api/internal/hermes/media/uuid-null-1',
      checksum: 'ghi789',
      media_type: null,  // legacy row with no media_type
      aspect_ratio: null,
      width_px: null,
      height_px: null,
      duration_seconds: null,
    },
  ], async () => {
    const jobId = 'mkt_null_ws_test';
    const view = await buildSocialContentWorkspaceView(jobId, {
      runtimeDoc: makeMinimalDoc(jobId),
    });

    const assets = view.creativeReview?.assets ?? [];
    const asset = assets.find((a) => a.assetId === 'null_asset');
    assert.ok(asset, 'null media_type asset must appear');
    assert.equal(asset!.contentType, 'image/png', 'null media_type must default to image/png (not video)');
    assert.equal(asset!.title, 'Generated Image', 'null media_type must default to Generated Image');
  });
});

test('mixed batch: image and video assets in same view', async () => {
  await withEnv([
    {
      id: 'uuid-img-m', source_asset_id: 'img_m', served_asset_ref: '/api/internal/hermes/media/uuid-img-m',
      checksum: 'img_chk', media_type: 'image', aspect_ratio: '4:5', width_px: null, height_px: null, duration_seconds: null,
    },
    {
      id: 'uuid-vid-m', source_asset_id: 'vid_m', served_asset_ref: '/api/internal/hermes/media/uuid-vid-m',
      checksum: 'vid_chk', media_type: 'video', aspect_ratio: '9:16', width_px: 1080, height_px: 1920, duration_seconds: 10,
    },
  ], async () => {
    const jobId = 'mkt_mixed_ws_test';
    const view = await buildSocialContentWorkspaceView(jobId, {
      runtimeDoc: makeMinimalDoc(jobId),
    });

    const assets = view.creativeReview?.assets ?? [];
    assert.ok(assets.length >= 2, 'at least two assets expected');

    const img = assets.find((a) => a.assetId === 'img_m');
    const vid = assets.find((a) => a.assetId === 'vid_m');
    assert.ok(img && vid, 'both image and video must appear');
    assert.equal(img!.contentType, 'image/png');
    assert.equal(vid!.contentType, 'video/mp4');
    assert.equal(img!.title, 'Generated Image');
    assert.equal(vid!.title, 'Generated Video');
  });
});
