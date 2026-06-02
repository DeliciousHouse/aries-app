/**
 * End-to-end binding test for the ingest reader→SQL wiring: proves that a
 * variant-tagged doc actually threads variant_batch_id ($6) and variant_index
 * ($7) into the creative_assets INSERT (the single load-bearing guarantee of the
 * board grouping — a dropped/reordered binding would silently write NULL and
 * break the board, with every other test still green). Self-contained: a temp
 * HERMES_IMAGE_CACHE_MOUNT with a real image file + a mock pool, no live DB.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/ingest-variant-binding.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestProductionCreativeAssetsToDb } from '../../backend/marketing/ingest-production-assets';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

function stageRecord(stage: string) {
  return { stage, status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] };
}

function makeDoc(request: Record<string, unknown>, creativeAssets: unknown[]): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'mkt_variant_job',
    tenant_id: '42',
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research'),
      strategy: stageRecord('strategy'),
      production: { ...stageRecord('production'), primary_output: { artifacts: { creative_assets: creativeAssets } } },
      publish: stageRecord('publish'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

function makeMockPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: [{ id: 'uuid-1' }], rowCount: 1 });
    },
  };
  return { pool, calls };
}

async function withMount<T>(fn: (mount: string) => Promise<T>): Promise<T> {
  const mount = path.join(tmpdir(), `aries-variant-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(mount, { recursive: true });
  const prev = process.env.HERMES_IMAGE_CACHE_MOUNT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  try {
    return await fn(mount);
  } finally {
    if (prev === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prev;
    await rm(mount, { recursive: true, force: true });
  }
}

test('ingest binds variant_batch_id ($6) and variant_index ($7) from doc.inputs.request', async () => {
  await withMount(async (mount) => {
    await writeFile(path.join(mount, 'v2.png'), Buffer.from('variant-2-image-bytes'));
    const doc = makeDoc({ variant_batch_id: 'vbatch_x', variant_index: 2 }, [
      { assetId: 'a2', type: 'image', path: '/home/node/.hermes/cache/images/v2.png' },
    ]);
    const { pool, calls } = makeMockPool();
    const result = await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_variant_job', tenantId: 42, doc, pool });
    assert.equal(result.inserted, 1);
    const insert = calls.find((c) => /INSERT INTO creative_assets/.test(c.sql));
    assert.ok(insert, 'an INSERT happened');
    assert.equal(insert!.params[5], 'vbatch_x', 'param $6 carries the batch id');
    assert.equal(insert!.params[6], 2, 'param $7 carries the variant index');
  });
});

test('ingest leaves variant tags NULL for a normal (untagged) weekly post', async () => {
  await withMount(async (mount) => {
    await writeFile(path.join(mount, 'plain.png'), Buffer.from('plain-image-bytes'));
    const doc = makeDoc({ primaryGoal: 'x' }, [
      { assetId: 'a0', type: 'image', path: '/home/node/.hermes/cache/images/plain.png' },
    ]);
    const { pool, calls } = makeMockPool();
    await ingestProductionCreativeAssetsToDb({ jobId: 'mkt_plain', tenantId: 42, doc, pool });
    const insert = calls.find((c) => /INSERT INTO creative_assets/.test(c.sql));
    assert.equal(insert!.params[5], null, 'no batch id on a normal post');
    assert.equal(insert!.params[6], null, 'no variant index on a normal post');
  });
});
