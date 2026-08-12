/**
 * AA-235 / DEFECT B — a refusal must never become an approved post.
 *
 * THE INCIDENT, exactly. Weekly job mkt_b905de48 (tenant, 2026-08-12) reached
 * the publish agent with no inputs. The agent answered honestly: seven
 * `"theme": "gap"` entries explaining what it was missing —
 *
 *   "Missing brand-kit research, campaign context, and approved content
 *    package for publish-stage execution."
 *
 * — and labelled its own output `"stage": "strategy"`. The production stage had
 * emitted `artifacts.creative_assets` and NO `content_package`.
 * `extractContentPackage` fell back to the PUBLISH stage's content_package,
 * `buildCaption` joined hook+body+cta into `posts.caption`,
 * `INSERT_SYNTHESIZED_POST_SQL` hard-coded `'approved','approved'`, and the
 * autoscheduler shipped them. Two Facebook posts and one Instagram post went
 * live on real brand accounts.
 *
 * Nothing between generation and publish asked whether the text was content.
 * These tests pin the two gates that now do:
 *
 *   1. no publish-stage fallback for `content_package` — production is the only
 *      source, and its absence is a recorded FAILURE, not a substitution;
 *   2. a publish artifact that declares a different `stage` is DISTRUSTED — its
 *      schedule and publish_package are ignored — but does not by itself
 *      discard the week. That calibration is load-bearing and is pinned below:
 *      21 of the 87 persisted documents with a publish artifact declare some
 *      other stage, and 16 of those carry good production copy and synthesized
 *      real posts. Failing on the label alone would break roughly a fifth of
 *      publishing weeks; failing on missing production copy catches all three
 *      documents that actually had none — including this incident.
 *
 * The document fixtures below are the real persisted shapes, trimmed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  markPublishArtifactStageMismatch,
  markPublishFailedOnUnpublishableContent,
} from '../../backend/marketing/hermes-callbacks';
import { synthesizePublishPostsFromContentPackage } from '../../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

/** The refusal prose the publish agent actually returned, verbatim. */
const REFUSAL_ENTRIES = [
  {
    post_number: 1,
    theme: 'gap',
    hook: 'Missing brand-kit research, campaign context, and approved content package for publish-stage execution.',
    body: 'The request begins at the publish stage but does not include the brand name, voice, offer, palette, constraints, platforms, approved copy, or creative assets. Publishing cannot proceed safely without those inputs.',
    cta: 'Provide the approved upstream workflow output for Aries run arun_85025bff.',
    platforms: ['instagram', 'facebook'],
    format: 'carousel',
  },
  {
    post_number: 2,
    theme: 'gap',
    hook: 'Missing approved post copy and creative asset for the second publish slot.',
    body: 'No upstream research, strategy, or production artifacts were included.',
    cta: 'Attach the approved content package and corresponding image asset.',
    platforms: ['instagram', 'facebook'],
    format: 'carousel',
  },
];

function stageRecord(name: string, primaryOutput: unknown, status = 'completed') {
  return {
    stage: name, status, started_at: null, completed_at: '2026-08-12T06:00:00.000Z',
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

/**
 * The incident document: production delivered images and NO content_package;
 * the publish stage's primary_output is the refusal, self-labelled 'strategy'.
 */
function incidentDoc(overrides: {
  productionOutput?: unknown;
  publishOutput?: unknown;
} = {}): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0',
    job_id: 'mkt_aa235_incident', tenant_id: '15', job_type: 'weekly_social_content',
    // The terminal callback has ALREADY completed the job by the time synthesis
    // runs — that ordering is what made the incident invisible.
    state: 'completed', status: 'completed', current_stage: 'publish',
    created_by: 'weekly-trigger-worker',
    stages: {
      research: stageRecord('research', null),
      strategy: stageRecord('strategy', null),
      production: stageRecord(
        'production',
        overrides.productionOutput !== undefined
          ? overrides.productionOutput
          : {
              stage: 'production',
              artifacts: {
                creative_assets: [{ assetId: 'post-1-image', type: 'generated_image', post_number: 1 }],
                errors: [],
              },
            },
      ),
      publish: stageRecord(
        'publish',
        overrides.publishOutput !== undefined
          ? overrides.publishOutput
          : { stage: 'strategy', content_package: REFUSAL_ENTRIES },
      ),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: ['instagram', 'facebook'], live_publish_platforms: ['instagram', 'facebook'], video_render_platforms: [] },
    brand_kit: null,
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

function makePool() {
  const inserts: unknown[][] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (/INSERT INTO posts/i.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: inserts.length }], rowCount: 1 };
      }
      if (/FROM creative_assets/i.test(sql)) {
        return { rows: [{ id: 'uuid-img1', source_asset_id: 'post-1-image', media_type: 'image' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, inserts };
}

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aa235-gate-'));
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

// ---------------------------------------------------------------------------

test('AA-235: the incident document synthesizes ZERO posts', async () => {
  await withDataRoot(async () => {
    const { pool, inserts } = makePool();
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'mkt_aa235_incident', tenantId: 15, doc: incidentDoc(), publishRunId: null, pool,
    } as never);

    // THE REGRESSION. Before the fix this inserted four rows (2 entries x 2
    // platforms) whose captions were the agent's refusal, status 'approved'.
    assert.equal(inserts.length, 0, 'a refusal must not become a posts row');
    assert.equal(result.inserted, 0);
    assert.equal(
      result.reason,
      'production_content_package_missing',
      'the run is refused for the reason that actually distinguishes it: production delivered no copy',
    );
    // The mislabelled artifact is reported alongside, not instead.
    assert.equal(result.publishArtifactStageMismatch, 'strategy');
    // Belt and braces: no caption anywhere in what would have been written.
    const captions = inserts.map((params) => String(params[4] ?? ''));
    assert.equal(captions.some((c) => c.includes('Missing brand-kit research')), false);
  });
});

test('AA-235: production emitting no content_package is a recorded failure, not a fallback', async () => {
  await withDataRoot(async () => {
    const { pool, inserts } = makePool();
    // Publish output is correctly labelled this time, so ONLY the missing
    // production copy is under test — isolating gate 2 from gate 1.
    const doc = incidentDoc({ publishOutput: { stage: 'publish', content_package: REFUSAL_ENTRIES } });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'mkt_aa235_incident', tenantId: 15, doc, publishRunId: null, pool,
    } as never);

    assert.equal(inserts.length, 0, 'the publish stage is not a copy source');
    assert.equal(
      result.reason,
      'production_content_package_missing',
      'the missing production copy is named, not silently substituted',
    );
  });
});

test('AA-235: a mislabelled publish artifact is distrusted, not fatal — real production copy still ships', async () => {
  // THE CALIBRATION. 16 persisted documents look exactly like this: a publish
  // artifact declaring the wrong stage sitting on top of perfectly good
  // production copy (mkt_c8ee6236, the reference scenario in
  // tests/marketing/default-cadence-slots.test.ts, is one). Refusing them would
  // break roughly a fifth of publishing weeks over a string.
  await withDataRoot(async () => {
    const { pool, inserts } = makePool();
    const doc = incidentDoc({
      productionOutput: {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Real hook', body: 'Real body', cta: 'Shop now', hashtags: ['#real'], platforms: ['instagram'] },
        ],
      },
      // Mislabelled, and carrying a reel shape that must NOT be honoured.
      publishOutput: {
        stage: 'strategy',
        schedule: [{ post_number: 1, platforms: ['instagram'], placement: 'reel', media_type: 'video' }],
      },
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'mkt_aa235_mislabelled', tenantId: 15, doc, publishRunId: null, pool,
    } as never);

    assert.equal(result.reason, undefined, 'a wrong stage label must not discard the week');
    assert.equal(result.publishArtifactStageMismatch, 'strategy', 'but it IS reported');
    assert.ok(inserts.length > 0, 'real production copy still synthesizes posts');
    assert.match(String(inserts[0][4]), /Real hook/);
    // The distrusted artifact's schedule was ignored: the post keeps the default
    // feed shape instead of the reel/video shape that artifact asked for.
    assert.equal(inserts[0][8], 'feed', 'a mislabelled artifact does not get to shape the post');
  });
});

test('AA-235: a healthy run is completely unaffected', async () => {
  await withDataRoot(async () => {
    const { pool, inserts } = makePool();
    const doc = incidentDoc({
      productionOutput: {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Real hook', body: 'Real body', cta: 'Shop now', hashtags: ['#real'], platforms: ['instagram'] },
        ],
      },
      publishOutput: { stage: 'publish', schedule: [{ post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' }] },
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'mkt_aa235_ok', tenantId: 15, doc, publishRunId: null, pool,
    } as never);

    assert.equal(result.reason, undefined, 'no refusal on a healthy run');
    assert.ok(inserts.length > 0, 'real production copy still synthesizes posts');
    assert.match(String(inserts[0][4]), /Real hook/);
  });
});

test('AA-235: a publish artifact with no stage label is left alone (absence is not contradiction)', async () => {
  await withDataRoot(async () => {
    const { pool, inserts } = makePool();
    const doc = incidentDoc({
      productionOutput: {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'Real hook', body: 'Real body', cta: 'Shop now', hashtags: ['#real'], platforms: ['instagram'] },
        ],
      },
      // Most persisted documents and every pre-existing test omit `stage` here.
      publishOutput: { schedule: [{ post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' }] },
    });
    const result = await synthesizePublishPostsFromContentPackage({
      jobId: 'mkt_aa235_nolabel', tenantId: 15, doc, publishRunId: null, pool,
    } as never);

    assert.equal(result.reason, undefined);
    assert.ok(inserts.length > 0);
  });
});

// ---------------------------------------------------------------------------
// The refusal must also be VISIBLE. A completed job with zero posts and only a
// console line is how this stayed unnoticed long enough to publish.
// ---------------------------------------------------------------------------

test('AA-235: a content-validity refusal fails the completed job and records why', () => {
  const reason = 'production_content_package_missing';
  const doc = incidentDoc();
  assert.equal(doc.state, 'completed', 'precondition: the callback already completed the job');

  const marked = markPublishFailedOnUnpublishableContent(doc, { reason });

  assert.equal(marked, true);
  assert.equal(doc.state, 'failed');
  assert.equal(doc.status, 'failed');
  assert.equal(doc.stages.publish.status, 'failed');
  assert.equal(doc.last_error?.code, reason, 'the reason is on the document, not only in a log line');
  assert.equal(doc.last_error?.retryable, false, 'republishing cannot conjure copy that was never generated');
  assert.ok(
    (doc.history ?? []).some((h) => String(h.note ?? '').includes(reason)),
    'history records the cause',
  );
});

test('AA-235: a mislabelled artifact is recorded on the doc but leaves the job completed', () => {
  const doc = incidentDoc();
  assert.equal(markPublishArtifactStageMismatch(doc, { publishArtifactStageMismatch: 'strategy' }), true);
  assert.equal(doc.state, 'completed', 'recording an anomaly must not fail the run');
  assert.equal(doc.stages.publish.status, 'completed');
  assert.ok(
    (doc.history ?? []).some((h) => String(h.note ?? '').includes('declared stage \"strategy\"')),
    'the operator can see why the default cadence was used',
  );
  // Absent / blank is a no-op.
  for (const value of [undefined, '', '   ']) {
    const clean = incidentDoc();
    assert.equal(markPublishArtifactStageMismatch(clean, { publishArtifactStageMismatch: value }), false);
    assert.equal((clean.history ?? []).length, 0);
  }
});

test('AA-235: ordinary synthesis no-ops still complete normally', () => {
  for (const reason of [undefined, 'publish_package_present', 'no_content_package', 'no_tenant', 'no_connected_platform']) {
    const doc = incidentDoc();
    assert.equal(markPublishFailedOnUnpublishableContent(doc, reason ? { reason } : {}), false);
    assert.equal(doc.state, 'completed', `reason=${String(reason)} must not fail the job`);
  }
  for (const result of [null, undefined]) {
    const doc = incidentDoc();
    assert.equal(markPublishFailedOnUnpublishableContent(doc, result), false);
    assert.equal(doc.state, 'completed');
  }
});
