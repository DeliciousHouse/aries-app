import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-creative-per-family-'));
  const lobsterRoot = path.join(dataRoot, 'lobster');

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = lobsterRoot;
  process.env.OPENCLAW_LOBSTER_CWD = lobsterRoot;
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    if (previousLocalLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
    }
    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    }
    if (previousStage1CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE1_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir;
    }
    if (previousStage2CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE2_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir;
    }
    if (previousStage3CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    }
    if (previousStage4CacheDir === undefined) {
      delete process.env.LOBSTER_STAGE4_CACHE_DIR;
    } else {
      process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('buildCampaignWorkspaceView uses per-family hooks for Meta image ad cards instead of the shared hook', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { buildCampaignWorkspaceView } = await import('../backend/marketing/workspace-views');

    const jobId = 'mkt_per_family_hook_test';
    const tenantId = 'tenant_per_family_hook';
    const stage3RunId = 'run-prod-per-family';
    const brandSlug = 'per-family-test-brand';

    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const scriptwriterCachePath = path.join(process.env.LOBSTER_STAGE3_CACHE_DIR!, stage3RunId, 'scriptwriter.json');
    const campaignRoot = path.join(process.env.OPENCLAW_LOBSTER_CWD!, 'output', `${brandSlug}-campaign`);
    const adImagesDir = path.join(campaignRoot, 'ad-images');
    const image1Path = path.join(adImagesDir, 'meta-outcome-proof.png');
    const image2Path = path.join(adImagesDir, 'meta-problem-to-promise.png');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(path.dirname(scriptwriterCachePath), { recursive: true });
    await mkdir(adImagesDir, { recursive: true });

    await writeFile(image1Path, 'png-placeholder-1', 'utf8');
    await writeFile(image2Path, 'png-placeholder-2', 'utf8');

    await writeFile(
      scriptwriterCachePath,
      JSON.stringify({
        script_assets: {
          meta_ad_scripts_by_family: {
            'meta-outcome-proof': {
              family_id: 'meta-outcome-proof',
              family_name: 'Outcome Proof',
              funnel_stage: 'consideration',
              hook: 'See the results operators get before their launch even starts.',
              body: 'Every operator leaves with a proven launch system.',
              proof_points: ['Outcome clarity', 'Operator proof'],
              primary_cta: 'Book a call',
            },
            'meta-problem-to-promise': {
              family_id: 'meta-problem-to-promise',
              family_name: 'Problem to Promise',
              funnel_stage: 'awareness',
              hook: 'Most launches stall because the message never gets clear.',
              body: 'We fix that in a single sprint.',
              proof_points: ['Clear message', 'Fast launch'],
              primary_cta: 'Get started',
            },
          },
        },
      }, null, 2),
      'utf8',
    );

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: tenantId,
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: {
            stage: 'research',
            status: 'completed',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-research-pf',
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
            run_id: 'run-strategy-pf',
            summary: null,
            primary_output: { run_id: 'run-strategy-pf' },
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
            run_id: stage3RunId,
            summary: null,
            primary_output: { run_id: stage3RunId },
            outputs: {},
            artifacts: [],
            errors: [],
          },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: null,
            summary: null,
            primary_output: null,
            outputs: {
              approval_id: 'mkta_publish_pf',
              workflow_step_id: 'approve_stage_4',
            },
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            approval_id: 'mkta_publish_pf',
            workflow_name: 'marketing-pipeline',
            workflow_step_id: 'approve_stage_4',
            title: 'Creative review required',
            message: 'Review creative assets before publish.',
            requested_at: '2026-04-15T00:00:00.000Z',
            resume_token: 'resume-publish-pf',
            action_label: 'Review creative',
            publish_config: {
              platforms: ['meta-ads'],
              live_publish_platforms: ['meta-ads'],
              video_render_platforms: [],
            },
          },
          history: [],
        },
        publish_config: {
          platforms: ['meta-ads'],
          live_publish_platforms: ['meta-ads'],
          video_render_platforms: [],
        },
        brand_kit: {
          path: path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json'),
          source_url: 'https://per-family.example',
          canonical_url: 'https://per-family.example',
          brand_name: 'Per Family Test Brand',
          logo_urls: ['https://per-family.example/logo.png'],
          colors: {
            primary: '#111111',
            secondary: '#f5f5f5',
            accent: '#c24d2c',
            palette: ['#111111', '#f5f5f5', '#c24d2c'],
          },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-04-15T00:00:00.000Z',
          brand_voice_summary: 'Proof-led and direct.',
        },
        inputs: {
          request: {
            brandUrl: 'https://per-family.example',
            brandSlug: brandSlug,
          },
          brand_url: 'https://per-family.example',
          competitor_url: null,
          competitor_facebook_url: null,
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-04-15T00:00:00.000Z',
        updated_at: '2026-04-15T00:00:00.000Z',
      }, null, 2),
      'utf8',
    );

    const view = await buildCampaignWorkspaceView(jobId);

    assert.notEqual(view.creativeReview, null, 'creativeReview should be populated');

    const imageAdAssets = view.creativeReview!.assets.filter(
      (asset) => asset.notes.some((note) => note.startsWith('Ad hook:')),
    );

    assert.equal(imageAdAssets.length >= 2, true, 'expected at least 2 image_ad assets with Ad hook notes');

    const adHooks = imageAdAssets.map((asset) => {
      const hookNote = asset.notes.find((note) => note.startsWith('Ad hook:'));
      return hookNote ?? '';
    });

    assert.equal(
      adHooks.every((hook) => hook.length > 0),
      true,
      'all Ad hook notes should be non-empty',
    );
    assert.notEqual(
      adHooks[0],
      adHooks[1],
      `the two image_ad cards should have different Ad hook values but both got: "${adHooks[0]}"`,
    );

    const allHookText = adHooks.join('\n');
    assert.equal(
      allHookText.includes('See the results operators get before their launch even starts.'),
      true,
      'expected outcome-proof family hook to appear',
    );
    assert.equal(
      allHookText.includes('Most launches stall because the message never gets clear.'),
      true,
      'expected problem-to-promise family hook to appear',
    );
  });
});
