/**
 * Regression: the publish-skip completion path must ingest production
 * creative_assets.
 *
 * Bug (found via live E2E, 2026-06-02): when the production stage returns an
 * `approve_publish` `requires_approval` callback AND publishing is not required,
 * applyHermesMarketingCallback takes the "publish-skip" path, marks the job
 * completed, and returned WITHOUT calling ingestProductionCreativeAssetsOnCompletion
 * (which only ran in the separate `payload.status === 'completed'` branch). Result:
 * rendered images never landed in the creative_assets table and the dashboard
 * showed "No launch items" despite a successful render.
 *
 * This drives that exact path (numeric tenant so the ingest guard passes,
 * recognized creative_assets + a real file at the mount so ingestion reaches the
 * INSERT) and asserts a creative_assets INSERT is issued and the job completes.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/publish-skip-creative-ingest.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('publish-skip completion issues a creative_assets INSERT', async (t) => {
  const prev: Record<string, string | undefined> = {
    DATA_ROOT: process.env.DATA_ROOT,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ARIES_AUTO_APPROVE_MARKETING_PIPELINE: process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE,
    HERMES_IMAGE_CACHE_MOUNT: process.env.HERMES_IMAGE_CACHE_MOUNT,
  };
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-publish-skip-'));
  const mountDir = await mkdtemp(path.join(tmpdir(), 'aries-hermes-media-'));
  const basename = 'openai_gpt_image_ps_001.png';
  // Minimal valid-ish PNG bytes so the ingestion file read + checksum succeed.
  await writeFile(path.join(mountDir, basename), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '0';
  process.env.HERMES_IMAGE_CACHE_MOUNT = mountDir;

  try {
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime, loadSocialContentJobRuntime } =
      await import('../../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const poolMod = await import('../../lib/db');
    const pool = poolMod.default;

    // Spy the DB layer: capture SQL, never touch a real DB.
    const sqls: string[] = [];
    t.mock.method(pool, 'query', async (sql: unknown) => {
      sqls.push(String(sql));
      return { rows: [{ id: 1 }], rowCount: 1 } as never;
    });

    const doc = createSocialContentJobRuntimeDocument({
      jobId: `mkt_publish_skip_${Date.now()}`,
      tenantId: '999', // numeric → passes ingestProductionCreativeAssetsOnCompletion's guard
      payload: { brandUrl: 'https://brand.example', businessType: 'coaching', competitorUrl: '', imageCreativeCount: 1 },
      brandKit: {
        path: '/tmp/brand-kit.json', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
        brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [], external_links: [], extracted_at: new Date().toISOString(), brand_voice_summary: 'clear',
        offer_summary: null, positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes', domain: 'marketing', workflowKey: 'social_content_weekly', action: 'resume',
      tenantId: doc.tenant_id, marketingJobId: doc.job_id, stage: 'production',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-publish-skip-ingest',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-publish-skip-1',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish', approval_step: 'approve_publish', workflow_step_id: 'approve_stage_4',
        prompt: 'Review creative assets', resume_token: 'social_content_weekly:arun_ps:production',
      },
      output: [
        {
          stage: 'production',
          artifacts: {
            aspectRatio: '4:5',
            creative_assets: [
              { assetId: 'sl_asset_ps_01', type: 'generated_image', status: 'created', path: `/home/node/.hermes/cache/images/${basename}`, placement: 'post_1', prompt: 'Editorial image for post 1.' },
            ],
          },
          weekly_content_plan: { posts: [], image_creatives: [], video_scripts: [] },
        },
      ],
    });

    assert.equal(result.status, 'accepted', 'callback should be accepted');

    const after = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(after?.state, 'completed', 'job should complete via the publish-skip path');
    assert.notEqual(after?.stages.production.status, 'failed', 'production must not be failed');

    // The fix: a creative_assets INSERT is issued on the publish-skip completion.
    const ingested = sqls.some((s) => /insert\s+into\s+creative_assets/i.test(s));
    assert.ok(ingested, `publish-skip completion must INSERT into creative_assets (regression: No launch items). SQLs seen: ${sqls.map((s) => s.slice(0, 40)).join(' | ')}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataRoot, { recursive: true, force: true });
    await rm(mountDir, { recursive: true, force: true });
  }
});
