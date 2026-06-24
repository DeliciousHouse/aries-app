/**
 * Slice 1 — ingest-production-assets video support.
 *
 * Verifies that a Hermes `generated_video` creative_asset entry is ingested
 * with the correct `media_type`, `aspect_ratio`, `width_px`, `height_px`, and
 * `duration_seconds` SQL params, and that image entries still produce the
 * correct media_type / aspect_ratio (now bound as params $9/$10 rather than
 * hardcoded literals, after the video dims PR).
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/video-ingest-dims.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestProductionCreativeAssetsToDb } from '../../backend/marketing/ingest-production-assets';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDoc(creativeAssets: unknown[]): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'mkt_video_dims',
    tenant_id: '42',
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: {
        stage: 'production', status: 'completed', started_at: null, completed_at: null,
        failed_at: null, run_id: null, summary: null,
        primary_output: { artifacts: { creative_assets: creativeAssets } },
        outputs: {}, artifacts: [], errors: [],
      },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

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

async function withHermesMediaMount<T>(
  fn: (mount: string, hostImagePath: (basename: string) => string) => Promise<T>,
): Promise<T> {
  const mount = path.join(tmpdir(), `aries-video-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(mount, { recursive: true });
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
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

// ---------------------------------------------------------------------------
// Slice 1 — video entry dims
// ---------------------------------------------------------------------------

test('video entry: media_type=video, aspect_ratio=9:16, dims populated in SQL params', async () => {
  // FAIL BEFORE: params[8]='image', params[9]='4:5', params[10..12]=undefined
  // PASS AFTER:  params[8]='video', params[9]='9:16', params[10]=1080, [11]=1920, [12]=15
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'clip_reel_01.mp4';
    await writeFile(path.join(mount, basename), Buffer.from('fakevideobytes'));

    const doc = makeDoc([{
      assetId: 'vid_1',
      type: 'generated_video',
      path: hostImagePath(basename),
      media_type: 'video',
      surface: 'reel',
      width: 1080,
      height: 1920,
      duration_seconds: 15,
    }]);
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_vid1', tenantId: 42, doc, pool });

    assert.equal(result.total, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 0);
    assert.equal(calls.length, 1, 'exactly one INSERT expected');

    const { params } = calls[0];
    // Param positions (1-based SQL params, 0-based JS array):
    // $9=mediaType (params[8]), $10=aspectRatio (params[9]),
    // $11=widthPx (params[10]), $12=heightPx (params[11]), $13=durationSeconds (params[12])
    assert.equal(params[8], 'video', '$9 mediaType must be "video" for generated_video');
    assert.equal(params[9], '9:16', '$10 aspectRatio must be 9:16 (portrait from width<height)');
    assert.equal(params[10], 1080, '$11 widthPx must be 1080');
    assert.equal(params[11], 1920, '$12 heightPx must be 1920');
    assert.equal(params[12], 15, '$13 durationSeconds must be 15');
  });
});

test('video entry via media_type field (not type field): media_type=video', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'story_vid.mp4';
    await writeFile(path.join(mount, basename), Buffer.from('fakevideobytes'));

    const doc = makeDoc([{
      assetId: 'vid_2',
      type: 'something_else',   // NOT generated_video
      media_type: 'video',       // but explicit media_type=video
      path: hostImagePath(basename),
      surface: 'story',
      width: 1080,
      height: 1920,
      duration_seconds: 30,
    }]);
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_vid2', tenantId: 42, doc, pool });

    assert.equal(result.inserted, 1);
    const { params } = calls[0];
    assert.equal(params[8], 'video', 'media_type field takes precedence to identify video');
    assert.equal(params[9], '9:16', 'portrait aspect ratio from width < height');
    assert.equal(params[10], 1080);
    assert.equal(params[11], 1920);
    assert.equal(params[12], 30);
  });
});

test('image entry: media_type=image as param $9, aspect_ratio=4:5 as param $10, null dims', async () => {
  // FAIL BEFORE: SQL had hardcoded literals 'image'/'4:5'; after the change they
  // are params. This test asserts the PARAMS contain the correct values.
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'feed_image.png';
    await writeFile(path.join(mount, basename), Buffer.from('fakepng'));

    const doc = makeDoc([{
      assetId: 'img_1',
      type: 'generated_image',
      path: hostImagePath(basename),
      placement: 'feed',
      // no width/height/duration_seconds
    }]);
    const { pool, calls } = makeMockPool(1);
    await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_img1', tenantId: 42, doc, pool });

    const { params } = calls[0];
    assert.equal(params[8], 'image', '$9 mediaType must be "image" for generated_image');
    assert.equal(params[9], '4:5', '$10 aspectRatio must be "4:5" for feed image (no dims)');
    assert.equal(params[10], null, '$11 widthPx null when no dims provided');
    assert.equal(params[11], null, '$12 heightPx null');
    assert.equal(params[12], null, '$13 durationSeconds null');
  });
});

test('video entry without dims: fallback aspect_ratio from reel surface = 9:16, null dims params', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'reel_nodims.mp4';
    await writeFile(path.join(mount, basename), Buffer.from('fakevideo'));

    const doc = makeDoc([{
      assetId: 'vid_3',
      type: 'generated_video',
      path: hostImagePath(basename),
      surface: 'reel',
      // no width/height/duration_seconds
    }]);
    const { pool, calls } = makeMockPool(1);
    await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_nodims', tenantId: 42, doc, pool });

    const { params } = calls[0];
    assert.equal(params[8], 'video');
    assert.equal(params[9], '9:16', 'reel surface without dims falls back to 9:16');
    assert.equal(params[10], null, 'widthPx null when no dims');
    assert.equal(params[11], null);
    assert.equal(params[12], null);
  });
});

test('landscape video (width > height): aspect_ratio=4:5', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'landscape.mp4';
    await writeFile(path.join(mount, basename), Buffer.from('fakevideo'));

    const doc = makeDoc([{
      assetId: 'vid_4',
      type: 'generated_video',
      path: hostImagePath(basename),
      width: 1920,
      height: 1080,
      duration_seconds: 60,
    }]);
    const { pool, calls } = makeMockPool(1);
    await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_landscape', tenantId: 42, doc, pool });

    const { params } = calls[0];
    assert.equal(params[8], 'video');
    assert.equal(params[9], '4:5', 'landscape (width > height) maps to 4:5');
    assert.equal(params[10], 1920);
    assert.equal(params[11], 1080);
    assert.equal(params[12], 60);
  });
});

test('mixed batch: image + video both insert with correct dims', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const imgBasename = 'feed.png';
    const vidBasename = 'reel.mp4';
    await writeFile(path.join(mount, imgBasename), Buffer.from('fakepng'));
    await writeFile(path.join(mount, vidBasename), Buffer.from('fakevideo'));

    const doc = makeDoc([
      { assetId: 'img_1', type: 'generated_image', path: hostImagePath(imgBasename) },
      { assetId: 'vid_1', type: 'generated_video', path: hostImagePath(vidBasename), width: 1080, height: 1920, duration_seconds: 10 },
    ]);
    const { pool, calls } = makeMockPool(1);
    const result = await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_mixed', tenantId: 42, doc, pool });

    assert.equal(result.total, 2);
    assert.equal(result.inserted, 2);
    assert.equal(calls.length, 2);

    // First is img (ordered by iteration, not source_asset_id in this test)
    const imgCall = calls.find((c) => c.params[8] === 'image');
    const vidCall = calls.find((c) => c.params[8] === 'video');
    assert.ok(imgCall, 'image INSERT expected');
    assert.ok(vidCall, 'video INSERT expected');

    assert.equal(imgCall!.params[9], '4:5');
    assert.equal(imgCall!.params[10], null);

    assert.equal(vidCall!.params[9], '9:16');
    assert.equal(vidCall!.params[10], 1080);
    assert.equal(vidCall!.params[11], 1920);
    assert.equal(vidCall!.params[12], 10);
  });
});

// ---------------------------------------------------------------------------
// Guard: the SQL now binds media_type and aspect_ratio as params (not literals)
// Before the PR: INSERT had hardcoded 'image'/'4:5' literals.
// After the PR: $9/$10 — the values appear in params, not in the SQL text.
// ---------------------------------------------------------------------------

test('INSERT SQL: media_type and aspect_ratio are bound as params, not SQL literals', async () => {
  await withHermesMediaMount(async (mount, hostImagePath) => {
    const basename = 'check_sql.png';
    await writeFile(path.join(mount, basename), Buffer.from('fakepng'));
    const doc = makeDoc([{ assetId: 'img_sql', type: 'generated_image', path: hostImagePath(basename) }]);
    const { pool, calls } = makeMockPool(1);
    await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_sql_check', tenantId: 42, doc, pool });

    const { sql } = calls[0];
    // The old SQL had hardcoded 'image' and '4:5' literals; the new SQL uses $9/$10.
    // Asserting these are NOT literals guards against the old implementation.
    assert.ok(!sql.includes("'image'"), "SQL must NOT hardcode 'image' literal (now $9 param)");
    assert.ok(!sql.includes("'4:5'"), "SQL must NOT hardcode '4:5' literal (now $10 param)");
    // The new params ARE in the params array.
    assert.equal(calls[0].params[8], 'image');
    assert.equal(calls[0].params[9], '4:5');
  });
});
