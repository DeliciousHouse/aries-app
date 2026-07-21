/**
 * Reel-publish fix #1 — synthesis-time video-asset gate.
 *
 * A video-shaped (post, platform) target must link a real ingested VIDEO
 * creative_asset. When the job has none (the Hermes agent never called
 * video_generate — the 2026-07-13 posts 415/416 incident), the target is
 * DROPPED at synthesis instead of producing a dead reel post that fails
 * dispatch terminally (or, before #841, retry-spammed until campaign end).
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/reel-video-synthesis-gate.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

function makeDoc(
  jobId: string,
  schedule: unknown[],
  opts: { createdBy?: string; contentPackage?: unknown[] } = {},
): SocialContentJobRuntimeDocument {
  const contentPackage = opts.contentPackage ?? [
    { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'] },
    { post_number: 2, hook: 'H2', body: 'B2', cta: 'C2', hashtags: ['#b'], platforms: ['instagram'] },
  ];
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '15', job_type: 'weekly_social_content', state: 'completed', status: 'completed',
    current_stage: 'publish',
    created_by: opts.createdBy ?? null,
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', { stage: 'production', content_package: contentPackage }),
      publish: stage('publish', { stage: 'publish', schedule }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-gate-'));
  const prev = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function makePool(assetRows: unknown[]) {
  const inserts: unknown[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (/INSERT INTO posts/i.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }], rowCount: 1 };
      }
      if (/FROM creative_assets/i.test(sql)) {
        return { rows: assetRows, rowCount: assetRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, inserts };
}

async function withVideoFlag<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
  process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    else process.env.ARIES_VIDEO_PUBLISH_ENABLED = prev;
  }
}

test('gate: reel target with NO ingested video asset is dropped (no dead post row)', async () => {
  // FAIL BEFORE: the reel row was inserted with an image asset (or none) and
  //   died at dispatch — 'no video asset ingested for reel', posts 415/416.
  // PASS AFTER:  the row is never created; droppedVideoNoAsset reports it.
  await withDataRoot(() => withVideoFlag(async () => {
    // Image-only job output: the agent skipped video_generate.
    const { pool, inserts } = makePool([
      { id: 'uuid-img1', source_asset_id: 'img_1', media_type: 'image' },
      { id: 'uuid-img2', source_asset_id: 'img_2', media_type: 'image' },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
      { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
    ];
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_no_vid', tenantId: 15, doc: makeDoc('job_no_vid', schedule), publishRunId: null, pool,
    });

    assert.equal(result.droppedVideoNoAsset, 1, 'the reel target is reported dropped');
    const reel = inserts.find((p) => p[8] === 'reel');
    assert.equal(reel, undefined, 'no reel post row is created');
    const feed = inserts.find((p) => p[8] === 'feed');
    assert.ok(feed, 'the feed image post still synthesizes (weekly job not collateral damage)');
    assert.deepEqual(feed![6], ['img_1'], 'feed post keeps its image linkage');
  }));
});

test('gate: reel target links the VIDEO asset even when post_number maps to an image', async () => {
  // On a mixed job the post-number map indexes ALL assets, so post 2 maps to
  // img_2 — an image. The gate must link vid_1 (with its dims) instead.
  await withDataRoot(() => withVideoFlag(async () => {
    const { pool, inserts } = makePool([
      { id: 'uuid-img1', source_asset_id: 'img_1', media_type: 'image' },
      { id: 'uuid-img2', source_asset_id: 'img_2', media_type: 'image' },
      { id: 'uuid-vid1', source_asset_id: 'vid_1', media_type: 'video', width_px: 1080, height_px: 1920, duration_seconds: 12 },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
      { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
    ];
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_mixed', tenantId: 15, doc: makeDoc('job_mixed', schedule), publishRunId: null, pool,
    });

    assert.equal(result.droppedVideoNoAsset, 0);
    const reel = inserts.find((p) => p[8] === 'reel');
    assert.ok(reel, 'reel post inserted');
    assert.deepEqual(reel![6], ['vid_1'], 'reel links the video asset, not img_2');
    assert.equal(reel![11], 1080, 'video dims come from the video asset');
    assert.equal(reel![12], 1920);
    assert.equal(reel![13], 12);
  }));
});

test('gate: reel-companion job with no video asset synthesizes ZERO posts', async () => {
  // The clamp drops feed entries; the gate drops the reel entry. Nothing is
  // synthesized — the outcome gate (reel-video-outcome.ts) then fails the job.
  await withDataRoot(() => withVideoFlag(async () => {
    const { pool, inserts } = makePool([
      { id: 'uuid-img1', source_asset_id: 'img_1', media_type: 'image' },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
    ];
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_reelco',
      tenantId: 15,
      doc: makeDoc('job_reelco', schedule, {
        createdBy: 'reel:src-weekly-job',
        contentPackage: [
          { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'] },
        ],
      }),
      publishRunId: null,
      pool,
    });

    assert.equal(inserts.length, 0, 'no posts synthesized at all');
    assert.equal(result.inserted, 0);
    assert.equal(result.droppedVideoNoAsset, 1);
  }));
});

test('gate: image-only job with no video shapes is byte-identical (no drops)', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makePool([
      { id: 'uuid-img1', source_asset_id: 'img_1', media_type: 'image' },
      { id: 'uuid-img2', source_asset_id: 'img_2', media_type: 'image' },
    ]);
    const schedule = [
      { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
      { post_number: 2, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
    ];
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_imgs', tenantId: 15, doc: makeDoc('job_imgs', schedule), publishRunId: null, pool,
    });

    assert.equal(result.droppedVideoNoAsset, 0);
    assert.equal(inserts.length, 2, 'both feed posts synthesized');
    assert.deepEqual(inserts.map((p) => p[6]), [['img_1'], ['img_2']], 'post-number image mapping unchanged');
  });
});
