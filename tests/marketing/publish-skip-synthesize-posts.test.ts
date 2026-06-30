/**
 * Regression: the publish-SKIP completion path must synthesize reviewable
 * `posts` when ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED is ON — WITHOUT
 * auto-scheduling/auto-publishing.
 *
 * Bug (found via prod investigation, 2026-06-30, tenant 60 / Hammad): a weekly
 * job completes with publishingRequested=false, takes the publish-skip path,
 * ingests images into creative_assets but NEVER synthesizes `posts`. The copy
 * (hook/body/cta/hashtags) is generated and sits in
 * production.primary_output.content_package, but the publish queue + review
 * queue both read from synthesized posts, so the operator gets images with no
 * captions and NO "Publish"/"Approve" control anywhere — "generated images but
 * nowhere to click to publish."
 *
 * The fix synthesizes the content_package into `approved` posts on this path so
 * they surface with a manual "Publish now" button. The SAFETY CONTRACT
 * (`autoSchedule:false`) is that it must NOT auto-schedule/auto-publish even
 * with BOTH ARIES_AUTO_APPROVE_MARKETING_PIPELINE and
 * ARIES_AUTOSCHEDULE_ON_APPROVAL on (those are prod-on) — publishing was not
 * requested; the human still clicks publish.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/publish-skip-synthesize-posts.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSynthesizeOnPublishSkipEnabled } from '../../backend/marketing/synthesize-on-publish-skip-env';

// --- Flag parser matrix -------------------------------------------------------

test('isSynthesizeOnPublishSkipEnabled: truthy values enable (case/space-insensitive)', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', ' On ', '  1  ']) {
    assert.equal(
      isSynthesizeOnPublishSkipEnabled({ ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED: v }),
      true,
      `"${v}" should enable`,
    );
  }
});

test('isSynthesizeOnPublishSkipEnabled: falsy / unset / garbage stays OFF (default)', () => {
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', '2', undefined]) {
    assert.equal(
      isSynthesizeOnPublishSkipEnabled({ ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED: v as string | undefined }),
      false,
      `"${String(v)}" should not enable`,
    );
  }
  assert.equal(isSynthesizeOnPublishSkipEnabled({}), false, 'unset → OFF');
});

// --- Behavior: publish-skip path synthesis + safety contract ------------------

/**
 * Drive a production `approve_publish` requires_approval callback (publish-skip
 * branch: publishingRequested=false) through handleHermesRunCallback with a
 * mocked pool, and return the SQL strings issued. `flagValue` sets
 * ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED. BOTH auto-publish flags are forced
 * ON to prove the `autoSchedule:false` safety contract suppresses scheduling
 * regardless.
 */
async function runPublishSkip(
  flagValue: string | undefined,
  opts: { variantBoard?: boolean } = {},
): Promise<{ sqls: string[]; state: string | undefined }> {
  const tag = `${flagValue ?? 'off'}${opts.variantBoard ? '_vb' : ''}`;
  const prev: Record<string, string | undefined> = {
    DATA_ROOT: process.env.DATA_ROOT,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ARIES_AUTO_APPROVE_MARKETING_PIPELINE: process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE,
    ARIES_AUTOSCHEDULE_ON_APPROVAL: process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL,
    ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED: process.env.ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED,
    HERMES_IMAGE_CACHE_MOUNT: process.env.HERMES_IMAGE_CACHE_MOUNT,
  };
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-publish-skip-synth-'));
  const mountDir = await mkdtemp(path.join(tmpdir(), 'aries-hermes-media-'));
  const basename = 'openai_gpt_image_pss_001.png';
  await writeFile(path.join(mountDir, basename), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  // Prod-on values: prove the safety contract holds even with both on.
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '1';
  process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL = '1';
  if (flagValue === undefined) delete process.env.ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED;
  else process.env.ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED = flagValue;
  process.env.HERMES_IMAGE_CACHE_MOUNT = mountDir;

  const sqls: string[] = [];
  let restorePool: (() => void) | null = null;
  try {
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime, loadSocialContentJobRuntime } =
      await import('../../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const poolMod = await import('../../lib/db');
    const pool = poolMod.default;

    const origQuery = pool.query.bind(pool);
    restorePool = () => {
      (pool as { query: typeof origQuery }).query = origQuery;
    };
    (pool as { query: unknown }).query = async (sql: unknown) => {
      sqls.push(String(sql));
      return { rows: [{ id: 1 }], rowCount: 1 } as never;
    };

    const doc = createSocialContentJobRuntimeDocument({
      jobId: `mkt_publish_skip_synth_${tag}_${dataRoot.slice(-6)}`,
      tenantId: '999',
      payload: { brandUrl: 'https://brand.example', businessType: 'coaching', competitorUrl: '', imageCreativeCount: 1 },
      brandKit: {
        path: '/tmp/brand-kit.json', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
        brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [], external_links: [], extracted_at: new Date().toISOString(), brand_voice_summary: 'clear',
        offer_summary: null, positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      },
    });
    if (opts.variantBoard) {
      // Mark this an onboarding variant-board job awaiting a pick: variant tags
      // present + variant_pick_finalized not true → isVariantBoardJobAwaitingPick
      // is true, so the publish-skip synthesis must be skipped.
      const d = doc as unknown as { inputs?: { request?: Record<string, unknown> } };
      d.inputs ??= {};
      d.inputs.request ??= {};
      d.inputs.request.variant_batch_id = 'vb_test_batch';
      d.inputs.request.variant_index = 1;
    }
    saveSocialContentJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes', domain: 'marketing', workflowKey: 'social_content_weekly', action: 'resume',
      tenantId: doc.tenant_id, marketingJobId: doc.job_id, stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: `evt-publish-skip-synth-${tag}`,
      aries_run_id: run.aries_run_id,
      hermes_run_id: `hermes-publish-skip-synth-${tag}`,
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish', approval_step: 'approve_publish', workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets', resume_token: 'social_content_weekly:arun_pss:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {
            aspectRatio: '4:5',
            creative_assets: [
              { assetId: 'sl_asset_pss_01', type: 'generated_image', status: 'created', path: `/home/node/.hermes/cache/images/${basename}`, placement: 'post_1', prompt: 'Editorial image for post 1.' },
            ],
          },
          // The generated copy the publish-skip path must surface as posts.
          content_package: [
            {
              post_number: 1,
              theme: 'educational',
              hook: 'Marketing gets expensive when every week starts from zero.',
              body: 'A weekly social content system: plan, review, approve, publish.',
              cta: 'Save this as your weekly reminder.',
              hashtags: ['#SmallBusinessMarketing', '#ContentWorkflow'],
              platforms: ['instagram', 'facebook'],
              format: 'single_image',
            },
          ],
          weekly_content_plan: { posts: [], image_creatives: [], video_scripts: [] },
        },
      ],
    });

    const after = await loadSocialContentJobRuntime(doc.job_id);
    return { sqls, state: after?.state };
  } finally {
    if (restorePool) restorePool();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataRoot, { recursive: true, force: true });
    await rm(mountDir, { recursive: true, force: true });
  }
}

const INSERT_POSTS = /insert\s+into\s+posts\b/i;
const INSERT_SCHEDULED = /insert\s+into\s+scheduled_posts\b/i;
// The distinctive FIRST DB action inside autoScheduleApprovedPostsForJob (after
// the window check, which passes because the doc has a created_at). It fires iff
// the `autoSchedule !== false` guard is ABSENT — so asserting it never fires is
// what makes this test SENSITIVE to the guard (the deeper scheduled_posts INSERT
// is unreachable here because the default-cadence path needs a parseable
// idempotency_key the mock does not return). Same matcher as
// tests/marketing/autoschedule-on-approval.test.ts.
const AUTO_SCHEDULE_POSTS_SELECT = /select[\s\S]*idempotency_key[\s\S]*from\s+posts/i;

test('flag ON → publish-skip synthesizes posts but does NOT auto-schedule (safety contract)', async () => {
  const { sqls, state } = await runPublishSkip('1');
  assert.equal(state, 'completed', 'job should complete via the publish-skip path');
  assert.ok(
    sqls.some((s) => INSERT_POSTS.test(s)),
    `flag ON must synthesize posts (INSERT INTO posts). SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')}`,
  );
  // The whole point: surface a publish button, NEVER auto-publish — even with
  // both auto flags ON. The auto-schedule path must never even be ENTERED: if a
  // future change drops the `autoSchedule !== false` guard, this SELECT fires
  // (both prod-on flags would open the gate) and this assertion fails. Both
  // auto-flags are forced ON in runPublishSkip precisely so this stays
  // sensitive to the guard, not to the flags.
  assert.equal(
    sqls.some((s) => AUTO_SCHEDULE_POSTS_SELECT.test(s)),
    false,
    `publish-skip must NOT enter the auto-schedule path (no auto-schedule posts SELECT). SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')}`,
  );
  assert.equal(
    sqls.some((s) => INSERT_SCHEDULED.test(s)),
    false,
    `publish-skip must NOT schedule/publish (no INSERT INTO scheduled_posts). SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')}`,
  );
});

test('flag ON + variant-board job awaiting pick → does NOT synthesize posts (unpicked variants)', async () => {
  const { sqls, state } = await runPublishSkip('1', { variantBoard: true });
  assert.equal(state, 'completed', 'job should still complete via the publish-skip path');
  // A held variant is a board option, not a final post: synthesizing publishable
  // posts here would let the operator publish an unpicked variant.
  assert.equal(
    sqls.some((s) => INSERT_POSTS.test(s)),
    false,
    `variant-board job awaiting pick must NOT synthesize posts. SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')}`,
  );
});

test('flag OFF (default) → publish-skip does NOT synthesize posts (byte-identical to today)', async () => {
  const { sqls, state } = await runPublishSkip(undefined);
  assert.equal(state, 'completed', 'job should still complete via the publish-skip path');
  assert.equal(
    sqls.some((s) => INSERT_POSTS.test(s)),
    false,
    `flag OFF must NOT synthesize posts. SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')}`,
  );
  // Images still ingest on this path regardless of the flag.
  assert.ok(
    sqls.some((s) => /insert\s+into\s+creative_assets/i.test(s)),
    'creative_assets ingest is unchanged when the flag is OFF',
  );
});
