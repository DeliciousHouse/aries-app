import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMarketingJobFacts } from '../backend/marketing/job-facts'
import {
  getMarketingJobStatusCached,
  resetMarketingJobStatusCacheForTests,
} from '../backend/marketing/jobs-status'
import { createMarketingJobRuntimeDocument, saveMarketingJobRuntime } from '../backend/marketing/runtime-state'
import { buildCampaignWorkspaceView } from '../backend/marketing/workspace-views'
import type {
  MarketingArtifactStageNumber,
  StepPayloadResolution,
} from '../backend/marketing/stage-artifact-resolution'
import { resolveProjectRoot } from './helpers/project-root'

const PROJECT_ROOT = resolveProjectRoot(import.meta.url)

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT
  const previousDataRoot = process.env.DATA_ROOT
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-workspace-facts-'))
  const lobsterRoot = path.join(dataRoot, 'lobster')

  process.env.CODE_ROOT = PROJECT_ROOT
  process.env.DATA_ROOT = dataRoot
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = lobsterRoot
  process.env.OPENCLAW_LOBSTER_CWD = lobsterRoot
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache')
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache')
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache')
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache')

  try {
    return await run(dataRoot)
  } finally {
    resetMarketingJobStatusCacheForTests()
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT
    else process.env.CODE_ROOT = previousCodeRoot
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT
    else process.env.DATA_ROOT = previousDataRoot
    if (previousLocalLobsterCwd === undefined) delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD
    else process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd
    if (previousStage1CacheDir === undefined) delete process.env.LOBSTER_STAGE1_CACHE_DIR
    else process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir
    if (previousStage2CacheDir === undefined) delete process.env.LOBSTER_STAGE2_CACHE_DIR
    else process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir
    if (previousStage4CacheDir === undefined) delete process.env.LOBSTER_STAGE4_CACHE_DIR
    else process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir
    await rm(dataRoot, { recursive: true, force: true })
  }
}

function makeRuntimeDoc(jobId: string, tenantId: string) {
  const runtimeDoc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      brandUrl: 'https://shared-brand.example.com',
      websiteUrl: 'https://shared-brand.example.com',
    },
    brandKit: {
      path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', tenantId, 'brand-kit.json'),
      source_url: 'https://shared-brand.example.com',
      canonical_url: 'https://shared-brand.example.com',
      brand_name: 'Shared Brand',
      logo_urls: [],
      colors: {
        primary: '#111111',
        secondary: '#f5f5f5',
        accent: '#c24d2c',
        palette: ['#111111', '#f5f5f5', '#c24d2c'],
      },
      font_families: ['Inter'],
      external_links: [],
      extracted_at: '2026-04-24T00:00:00.000Z',
      brand_voice_summary: 'Direct and proof-led.',
      offer_summary: 'Planning sprint.',
    },
  })

  runtimeDoc.state = 'running'
  runtimeDoc.status = 'running'
  runtimeDoc.current_stage = 'publish'
  runtimeDoc.stages.research.status = 'completed'
  runtimeDoc.stages.research.run_id = 'run-research'
  runtimeDoc.stages.strategy.status = 'completed'
  runtimeDoc.stages.strategy.run_id = 'run-strategy'
  runtimeDoc.stages.strategy.primary_output = { run_id: 'run-strategy' }
  runtimeDoc.stages.production.status = 'completed'
  runtimeDoc.stages.production.run_id = 'run-production'
  runtimeDoc.stages.production.primary_output = { run_id: 'run-production' }
  runtimeDoc.stages.publish.status = 'in_progress'
  runtimeDoc.stages.publish.run_id = 'run-publish'
  runtimeDoc.stages.publish.primary_output = { run_id: 'run-publish' }
  runtimeDoc.publish_config.platforms = ['meta-ads']
  runtimeDoc.publish_config.live_publish_platforms = ['meta-ads']

  return runtimeDoc
}

function resolvedPayload(
  runId: string,
  payload: Record<string, unknown>,
  filePath: string,
): StepPayloadResolution {
  return {
    runId,
    path: filePath,
    payload,
    source: 'cache',
  }
}

function payloadFor(stage: MarketingArtifactStageNumber, stepName: string): Record<string, unknown> {
  const key = `${stage}:${stepName}`
  switch (key) {
    case '2:website_brand_analysis':
      return {
        brand_slug: 'shared-brand',
        brand_analysis: {
          brand_name: 'Shared Brand',
          brand_promise: 'Proof-led planning for operators.',
          audience: 'Operators with launch pressure.',
          offer_summary: 'Planning sprint',
          brand_voice: ['Direct', 'Proof-led'],
        },
        artifacts: {},
      }
    case '2:campaign_planner':
      return {
        brand_slug: 'shared-brand',
        created_at: '2026-04-24T00:00:00.000Z',
        campaign_plan: {
          campaign_name: 'Shared Facts Campaign',
          objective: 'Launch with sharper proof',
          primary_cta: 'Book now',
          audience: 'Operators with launch pressure.',
          core_message: 'Sharpen the proof before launch day.',
          offer: 'Planning sprint',
          channel_plans: [
            {
              channel: 'meta-ads',
              creative_bias: 'Show proof before polish.',
              message: 'Sharpen the proof before launch day.',
            },
          ],
        },
      }
    case '2:strategy_review_preview':
      return {
        review_packet: {
          campaign_name: 'Shared Facts Campaign',
          objective: 'Launch with sharper proof',
          core_message: 'Sharpen the proof before launch day.',
          channels_in_scope: ['meta-ads'],
        },
      }
    case '3:production_review_preview':
      return {
        review_packet: {
          summary: {
            core_message: 'Production review ready.',
          },
        },
      }
    case '4:launch_review_preview':
      return {
        campaign_name: 'Shared Facts Campaign',
        review_bundle: {
          campaign_name: 'Shared Facts Campaign',
          summary: {
            core_message: 'Sharpen the proof before launch day.',
            offer_summary: 'Planning sprint.',
          },
          landing_page_preview: {
            headline: 'Sharpen the proof before launch day.',
            subheadline: 'Operators get a tighter launch story.',
            cta: 'Book now',
            sections: [],
          },
          script_preview: {
            meta_ad_hook: 'Sharpen the proof before launch day.',
            meta_ad_body: ['Operators get a tighter launch story.'],
            short_video_beats: [],
          },
          platform_previews: [],
        },
      }
    default:
      return {}
  }
}

async function writeStagePayload(
  stageCacheRoot: string,
  runId: string,
  stepName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(stageCacheRoot, runId, `${stepName}.json`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

test('shared MarketingJobFacts dedupe stage payload reads across status and workspace view', async () => {
  await withRuntimeEnv(async () => {
    const jobId = 'mkt_shared_facts'
    const tenantId = 'tenant_shared_facts'
    const runtimeDoc = makeRuntimeDoc(jobId, tenantId)
    const readCounts = new Map<string, number>()

    const facts = createMarketingJobFacts(runtimeDoc, null, {
      readStageStepPayload: async (_runtimeDoc, stage, stepName) => {
        const key = `${stage}:${stepName}`
        readCounts.set(key, (readCounts.get(key) ?? 0) + 1)
        return resolvedPayload(`run-${stage}`, payloadFor(stage, stepName), `/tmp/${key}.json`)
      },
      readJsonAtPath: async () => null,
    })

    const { payload: statusPayload } = await getMarketingJobStatusCached(
      tenantId,
      jobId,
      Date.now(),
      facts,
    )
    const workspaceView = await buildCampaignWorkspaceView(jobId, facts)

    assert.ok(statusPayload.reviewBundle)
    assert.equal(workspaceView.jobId, jobId)
    assert.equal(readCounts.get('4:launch_review_preview'), 1)
    assert.equal(readCounts.get('2:campaign_planner'), 1)
    assert.equal(readCounts.get('2:strategy_review_preview'), 1)
    assert.equal(readCounts.get('2:website_brand_analysis'), 1)
  })
})

test('buildCampaignWorkspaceView still works without an injected facts instance', async () => {
  await withRuntimeEnv(async () => {
    const jobId = 'mkt_workspace_back_compat'
    const tenantId = 'tenant_workspace_back_compat'
    const runtimeDoc = makeRuntimeDoc(jobId, tenantId)

    saveMarketingJobRuntime(jobId, runtimeDoc)
    await writeStagePayload(
      process.env.LOBSTER_STAGE2_CACHE_DIR!,
      'run-strategy',
      'campaign_planner',
      payloadFor(2, 'campaign_planner'),
    )
    await writeStagePayload(
      process.env.LOBSTER_STAGE2_CACHE_DIR!,
      'run-strategy',
      'website_brand_analysis',
      payloadFor(2, 'website_brand_analysis'),
    )
    await writeStagePayload(
      process.env.LOBSTER_STAGE2_CACHE_DIR!,
      'run-strategy',
      'strategy_review_preview',
      payloadFor(2, 'strategy_review_preview'),
    )
    await writeStagePayload(
      process.env.LOBSTER_STAGE3_CACHE_DIR!,
      'run-production',
      'production_review_preview',
      payloadFor(3, 'production_review_preview'),
    )
    await writeStagePayload(
      process.env.LOBSTER_STAGE4_CACHE_DIR!,
      'run-publish',
      'launch_review_preview',
      payloadFor(4, 'launch_review_preview'),
    )

    const view = await buildCampaignWorkspaceView(jobId)

    assert.equal(view.jobId, jobId)
    assert.equal(view.tenantId, tenantId)
  })
})

test('workspace-view chain files contain no sync filesystem reads', async () => {
  const files = [
    'app/api/marketing/jobs/[jobId]/handler.ts',
    'backend/marketing/asset-library.ts',
    'backend/marketing/dashboard-content.ts',
    'backend/marketing/workspace-views.ts',
  ]
  const forbiddenPattern = /\b(readFileSync|readdirSync|statSync|existsSync)\b/

  for (const relativePath of files) {
    const contents = await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8')
    assert.equal(
      forbiddenPattern.test(contents),
      false,
      `${relativePath} still contains a sync filesystem read`,
    )
  }
})
