import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';
import type { ExecutionRunRecord } from '../../backend/execution/run-store';

// Cause 3 regression test — callback ordering for creative_assets ingestion and
// publish-posts synthesis.
//
// The bug: the publish-completion callback called ingestProductionCreative-
// AssetsToDb (which reads doc.stages.production.primary_output) BEFORE
// markStageCompleted/markJobCompleted wrote that primary_output. The callback
// loads a fresh doc whose production stage is still in_progress (primary_output
// null), so the ingest silently inserted zero rows — and the synthesizer, with
// no creative_assets, also produced nothing. A real campaign on v0.1.5.2
// completed with 7 images in place and 0 creative_assets + 0 posts in the DB.
//
// This test drives the REAL callback `applyHermesMarketingCallback` with a
// multi-stage completed payload (production + publish) and asserts the
// creative_assets INSERTs actually reach the DB. It would fail with the old
// ordering: a mock pool driven by the pre-fix code records zero creative_assets
// inserts because primary_output is null at ingest time.
//
// The DB pool is a recording mock injected via globalThis.__ariesPgPool (the
// hook lib/db.ts uses), so no live database is required and nothing is
// persisted.

type QueryCall = { sql: string; params: unknown[] };

function installMockPool(): { calls: QueryCall[]; restore: () => void } {
  const calls: QueryCall[] = [];
  const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
  const prev = g.__ariesPgPool;
  g.__ariesPgPool = {
    query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      // creative_assets SELECT (synthesizer asset lookup) → return the rows the
      // ingest would have written, so the synthesizer can link them.
      if (/SELECT[\s\S]*FROM creative_assets/i.test(sql)) {
        return Promise.resolve({
          rows: [
            { id: 'uuid-1', source_asset_id: 'img_1' },
            { id: 'uuid-2', source_asset_id: 'img_2' },
          ],
          rowCount: 2,
        });
      }
      // INSERT statements → report one row affected.
      return Promise.resolve({ rows: [{ id: 'row-1' }], rowCount: 1 });
    },
  } as unknown as Pool;
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete g.__ariesPgPool;
      else g.__ariesPgPool = prev;
    },
  };
}

function makeStage(name: string, status: string, primaryOutput: unknown = null) {
  return {
    stage: name,
    status,
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: primaryOutput,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

// A runtime doc in the PRE-callback state: production is in_progress with a
// null primary_output — exactly the state the callback loads from disk.
function makePreCallbackDoc(jobId: string): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: '42',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: makeStage('research', 'completed'),
      strategy: makeStage('strategy', 'completed'),
      production: makeStage('production', 'in_progress'),
      publish: makeStage('publish', 'in_progress'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Test Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: null,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as SocialContentJobRuntimeDocument;
}

// A multi-stage completed payload: production (carrying creative_assets +
// content_package) and publish. The multi-stage branch runs ingest + synthesis
// and returns before auto-advance, so no Hermes port / network is touched.
function makeMultiStagePayload() {
  const contentPackage = [
    {
      post_number: 1,
      hook: 'Hook one.',
      body: 'Body one.',
      cta: 'CTA one.',
      hashtags: ['#one'],
      platforms: ['instagram'],
    },
    {
      post_number: 2,
      hook: 'Hook two.',
      body: 'Body two.',
      cta: 'CTA two.',
      hashtags: ['#two'],
      platforms: ['instagram'],
    },
  ];
  return {
    status: 'completed',
    stage: 'publish',
    hermes_run_id: 'hermes_run_multi',
    output: [
      {
        stage: 'production',
        content_package: contentPackage,
        artifacts: {
          creative_assets: [
            { assetId: 'img_1', type: 'generated_image', path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/openai_codex_a.png' },
            { assetId: 'img_2', type: 'generated_image', path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/openai_codex_b.png' },
          ],
          errors: [],
        },
      },
      {
        // Thin, plan-only publish_package — must NOT block synthesis.
        stage: 'publish',
        publish_package: {
          approval_gate: 'approved',
          cadence: 'one post per day',
          schedule: [{ day: 'Monday', post_number: 1 }],
        },
      },
    ],
  };
}

function makeRunRecord(jobId: string): ExecutionRunRecord {
  return {
    schema_name: 'aries_execution_run',
    schema_version: '1.0.0',
    aries_run_id: 'arun_test_cause3',
    provider: 'hermes',
    domain: 'marketing',
    workflow_key: 'marketing_pipeline',
    action: 'run',
    tenant_id: '42',
    marketing_job_id: jobId,
    approval_id: null,
    stage: 'publish',
    workflow_step_id: null,
    external_run_id: 'hermes_run_multi',
    status: 'completed',
    event_ids: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    result: null,
  } as unknown as ExecutionRunRecord;
}

test('publish-completion callback ingests creative_assets AFTER the stage output is written', async () => {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-cause3-'));
  process.env.DATA_ROOT = dataRoot;
  // Point the mount at the temp dir and create the two image files so the
  // ingest's basename resolution + readFile succeed.
  process.env.HERMES_IMAGE_CACHE_MOUNT = dataRoot;

  const mock = installMockPool();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
    await writeFile(path.join(dataRoot, 'openai_codex_b.png'), Buffer.from('b'));

    const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
    const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');

    const jobId = 'mkt_cause3_test';
    saveSocialContentJobRuntime(jobId, makePreCallbackDoc(jobId));

    await applyHermesMarketingCallback(
      makeRunRecord(jobId),
      makeMultiStagePayload() as never,
    );

    // The regression assertion: creative_assets INSERTs must have reached the
    // pool. Pre-fix, ingest ran against a null primary_output and inserted 0.
    const creativeInserts = mock.calls.filter((c) => /INSERT INTO creative_assets/i.test(c.sql));
    assert.equal(
      creativeInserts.length,
      2,
      'both production creative_assets must be ingested (callback ran ingest after the stage output was written)',
    );

    // The synthesizer must also have run — the thin publish_package must not
    // have blocked it — producing posts linked to the ingested assets.
    const postInserts = mock.calls.filter((c) => /INSERT INTO posts/i.test(c.sql));
    assert.equal(
      postInserts.length,
      2,
      'two content_package entries (instagram only) → two synthesized posts; thin publish_package did not block synthesis',
    );
    // Each synthesized post links a creative_asset_id.
    for (const insert of postInserts) {
      // creative_asset_ids is the only array param; find it by shape rather than
      // position (story-video appended media_type/surface columns after it).
      const creativeAssetIds = insert.params.find((p) => Array.isArray(p));
      assert.ok(
        Array.isArray(creativeAssetIds) && creativeAssetIds.length === 1,
        'synthesized post links exactly one creative asset',
      );
    }
  } finally {
    mock.restore();
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
