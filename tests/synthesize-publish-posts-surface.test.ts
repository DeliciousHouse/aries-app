import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

// Fake pool capturing INSERT params; SELECT creative_assets returns none.
function makeFakePool() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

function makeDoc(jobId: string, schedule: unknown[]): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '15', job_type: 'weekly_social_content', state: 'completed', status: 'completed',
    current_stage: 'publish',
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'] },
          { post_number: 2, hook: 'H2', body: 'B2', cta: 'C2', hashtags: ['#b'], platforms: ['instagram'] },
        ],
      }),
      publish: stage('publish', { stage: 'publish', schedule }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

const SCHEDULE = [
  { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
  { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
];

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'synth-surface-'));
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

test('flag OFF: reel/video entries are stripped; only feed/image persists with 4-segment surface key', async () => {
  await withDataRoot(async () => {
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    const { pool, inserts } = makeFakePool();
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'job_off', tenantId: 15, doc: makeDoc('job_off', SCHEDULE), publishRunId: null, pool,
    });
    assert.equal(inserts.length, 1, 'only the feed/image post is inserted');
    // INSERT params: [tenant, job, runId, platform, caption, idempotencyKey, assetIds, mediaType, surface]
    const params = inserts[0];
    assert.equal(params[5], 'job_off:1:instagram:feed');
    assert.equal(params[7], 'image');
    assert.equal(params[8], 'feed');
    assert.ok(result.inserted >= 1);
  });
});

test('flag ON: reel/video entry persists with 4-segment key + video/reel shape', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePool();
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_on', tenantId: 15, doc: makeDoc('job_on', SCHEDULE), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    assert.equal(inserts.length, 2);
    const reel = inserts.find((p) => p[8] === 'reel');
    assert.ok(reel, 'reel post inserted');
    assert.equal(reel![5], 'job_on:2:instagram:reel');
    assert.equal(reel![7], 'video');
  });
});
