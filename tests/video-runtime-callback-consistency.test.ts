import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MarketingDashboardSocialContentJobContent } from '../backend/marketing/dashboard-content';
import { buildSocialContentDashboardProjection } from '../backend/social-content/dashboard-projection';
import { ingestSocialContentVideoRenderOutput } from '../backend/social-content/media-ingest';
import { ensureSocialContentRuntimeState } from '../backend/social-content/runtime-state';
import { createExecutionRunRecord, loadExecutionRunRecord } from '../backend/execution/run-store';
import { handleHermesRunCallback } from '../backend/execution/hermes-callbacks';
import {
  createSocialContentJobRuntimeDocument,
  loadSocialContentJobRuntime,
  saveSocialContentJobRuntime,
} from '../backend/marketing/runtime-state';

function brandKit() {
  return {
    path: '/tmp/brand-kit.json',
    source_url: 'https://brand.example',
    canonical_url: 'https://brand.example',
    brand_name: 'Brand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: 'clear',
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  };
}

function seedVideoJob(jobId: string, tenantId = 'tenant-video-runtime') {
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'marketing agency',
      competitorUrl: 'https://competitor.example',
      jobType: 'weekly_social_content',
      videoRenderCount: 1,
      imageCreativeCount: 0,
    },
    brandKit: brandKit(),
  });
  saveSocialContentJobRuntime(jobId, doc);
  return doc;
}

function emptyDashboard(): MarketingDashboardSocialContentJobContent {
  return {
    post: null,
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses: {
      countsByStatus: {
        draft: 0,
        in_review: 0,
        ready: 0,
        ready_to_publish: 0,
        published_to_meta_paused: 0,
        scheduled: 0,
        live: 0,
      },
    },
  };
}

async function withVideoRuntimeEnv<T>(run: (ctx: { dataRoot: string; videoMount: string }) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousVideoMount = process.env.HERMES_VIDEO_CACHE_MOUNT;
  const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
  const root = await mkdtemp(path.join(tmpdir(), 'aries-video-callback-runtime-'));
  const dataRoot = path.join(root, 'data');
  const videoMount = path.join(root, 'hermes-video-media');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(videoMount, { recursive: true });
  process.env.DATA_ROOT = dataRoot;
  process.env.HERMES_VIDEO_CACHE_MOUNT = videoMount;
  process.env.HERMES_CACHE_DIR = path.join(root, 'unmounted-host-cache');
  try {
    return await run({ dataRoot, videoMount });
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousVideoMount === undefined) delete process.env.HERMES_VIDEO_CACHE_MOUNT;
    else process.env.HERMES_VIDEO_CACHE_MOUNT = previousVideoMount;
    if (previousHermesCacheDir === undefined) delete process.env.HERMES_CACHE_DIR;
    else process.env.HERMES_CACHE_DIR = previousHermesCacheDir;
    await rm(root, { recursive: true, force: true });
  }
}

test('host callback video path is read through the deployed mount and becomes a durable dashboard artifact', async () => {
  await withVideoRuntimeEnv(async ({ dataRoot, videoMount }) => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174020';
    const doc = seedVideoJob(jobId);
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });
    const basename = 'video_render_deployment_cache.mp4';
    const hostPath = `/home/node/.hermes/profiles/aries-content-generator/cache/videos/${basename}`;
    await writeFile(path.join(videoMount, basename), Buffer.from('deployment-video'));

    const result = await handleHermesRunCallback({
      event_id: 'evt-video-deployment-mount',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-video-deployment-mount',
      status: 'requires_approval',
      stage: 'video_render',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'approve_video_render',
        prompt: 'Review the rendered clip.',
        resume_token: 'resume-video-deployment',
      },
      output: [{
        artifacts: [{
          id: 'clip-primary',
          path: hostPath,
          mime_type: 'video/mp4',
          platform_slug: 'instagram_reels',
          family_id: 'weekly_primary',
          width: 1080,
          height: 1920,
          duration_seconds: 6,
        }],
      }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    const output = (after?.social_content_runtime as {
      stages?: { video_render?: { output?: { artifacts?: Array<Record<string, unknown>> } } };
    } | undefined)?.stages?.video_render?.output;
    const durablePath = String(output?.artifacts?.[0]?.path);
    const durableName = path.basename(durablePath);
    assert.equal(
      path.dirname(durablePath),
      path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos'),
    );
    assert.match(durableName, /^instagram-reels-weekly-primary-[0-9a-f]{32}\.mp4$/i);
    assert.equal(await readFile(durablePath, 'utf8'), 'deployment-video');
    assert.equal(
      output?.artifacts?.[0]?.url,
      `/api/marketing/jobs/${jobId}/assets/video-${path.parse(durableName).name}`,
    );

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(executionRecord?.status, 'awaiting_approval');
    const dashboard = buildSocialContentDashboardProjection(after!, emptyDashboard());
    const video = dashboard.assets.find((asset) => asset.type === 'video_ad');
    assert.ok(video, 'expected a dashboard-visible durable video artifact');
    assert.equal(video?.previewUrl, output?.artifacts?.[0]?.url);
  });
});

test('production-stage callbacks ingest later video outputs before converging marketing, social, and execution state', async () => {
  await withVideoRuntimeEnv(async ({ videoMount }) => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174029';
    const doc = seedVideoJob(jobId);
    doc.stages.publish.status = 'completed';
    saveSocialContentJobRuntime(jobId, doc);
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });
    const sourcePath = path.join(videoMount, 'later-output.mp4');
    await writeFile(sourcePath, 'later-output-video');

    const result = await handleHermesRunCallback({
      event_id: 'evt-production-stage-multi-output-video',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-production-stage-multi-output-video',
      status: 'completed',
      stage: 'production',
      output: [
        { artifacts: [] },
        {
          artifacts: [{
            id: 'clip-later-output',
            path: sourcePath,
            mime_type: 'video/mp4',
            platform_slug: 'instagram_reels',
            family_id: 'weekly_primary',
          }],
        },
      ],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    const marketingArtifacts = (after?.stages.production.primary_output as {
      artifacts?: Array<Record<string, unknown>>;
    } | null)?.artifacts ?? [];
    const socialArtifacts = ((after?.social_content_runtime as {
      stages?: { video_render?: { output?: { artifacts?: Array<Record<string, unknown>> } } };
    } | undefined)?.stages?.video_render?.output?.artifacts) ?? [];

    assert.equal(marketingArtifacts.length, 1);
    assert.equal(socialArtifacts.length, 1);
    assert.equal(marketingArtifacts[0].id, 'clip-later-output');
    assert.equal(socialArtifacts[0].id, 'clip-later-output');
    assert.equal(marketingArtifacts[0].url, socialArtifacts[0].url);
    assert.equal(await readFile(String(marketingArtifacts[0].path), 'utf8'), 'later-output-video');
    assert.equal(after?.stages.production.status, 'completed');
    assert.equal(loadExecutionRunRecord(run.aries_run_id)?.status, 'completed');

    const reloaded = await loadSocialContentJobRuntime(jobId);
    const reloadedArtifacts = (reloaded?.stages.production.primary_output as {
      artifacts?: Array<Record<string, unknown>>;
    } | null)?.artifacts ?? [];
    assert.equal(reloadedArtifacts.length, 1, 'the canonical successful artifact set must survive save/reload');
  });
});

test('artifact filesystem keys are deterministic, collision-resistant, and bounded to one safe component', async () => {
  await withVideoRuntimeEnv(async ({ videoMount }) => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174025';
    const sourcePaths = [
      path.join(videoMount, 'collision-a.mp4'),
      path.join(videoMount, 'collision-b.mp4'),
      path.join(videoMount, 'collision-long.mp4'),
    ];
    await Promise.all(sourcePaths.map((sourcePath, index) => writeFile(sourcePath, `clip-${index}`)));
    const originalOutput: Array<{ artifacts: Array<Record<string, unknown>> }> = [{
      artifacts: [
        { id: 'clip/a', path: sourcePaths[0], mime_type: 'video/mp4', platform_slug: 'social' },
        { id: 'clip-a', path: sourcePaths[1], mime_type: 'video/mp4', platform_slug: 'social' },
        { id: `clip-${'x'.repeat(1000)}`, path: sourcePaths[2], mime_type: 'video/mp4', platform_slug: 'social' },
      ],
    }];

    const firstOutput = structuredClone(originalOutput);
    const first = ingestSocialContentVideoRenderOutput(jobId, firstOutput);
    assert.equal(first.ingestedCount, 3);
    const firstArtifacts = firstOutput[0].artifacts;
    const firstPaths = firstArtifacts.map((artifact) => String(artifact.path));
    const firstUrls = firstArtifacts.map((artifact) => String(artifact.url));
    assert.equal(new Set(firstPaths).size, 3, 'lossy normalization must not project two IDs onto one file');
    assert.equal(new Set(firstUrls).size, 3, 'lossy normalization must not project two IDs onto one URL');
    for (const artifactPath of firstPaths) {
      const component = path.basename(artifactPath);
      assert.ok(Buffer.byteLength(component) <= 255, `filesystem component exceeds 255 bytes: ${component.length}`);
      assert.match(component, /-[0-9a-f]{32}\.mp4$/i, 'every key requires a stable collision-resistant suffix');
    }
    for (const url of firstUrls) {
      const assetId = decodeURIComponent(url.split('/').at(-1) ?? '');
      assert.ok(Buffer.byteLength(assetId, 'utf8') <= 200);
      assert.ok(Buffer.byteLength(`${assetId}-poster`, 'utf8') <= 200);
    }

    const secondOutput = structuredClone(originalOutput);
    ingestSocialContentVideoRenderOutput(jobId, secondOutput);
    assert.deepEqual(
      secondOutput[0].artifacts.map((artifact) => String(artifact.path)),
      firstPaths,
      'the same artifact identifiers must produce the same deterministic filesystem keys',
    );
    assert.deepEqual(secondOutput[0].artifacts.map((artifact) => String(artifact.url)), firstUrls);
  });
});

test('canonical artifacts sharing platform and family retain distinct files, URLs, and bytes by artifact id', async () => {
  await withVideoRuntimeEnv(async ({ videoMount }) => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174026';
    const firstSource = path.join(videoMount, 'shared-family-first.mp4');
    const secondSource = path.join(videoMount, 'shared-family-second.mp4');
    await writeFile(firstSource, 'first-clip-bytes');
    await writeFile(secondSource, 'second-clip-bytes');
    const output: Array<{ artifacts: Array<Record<string, unknown>> }> = [{
      artifacts: [
        {
          id: 'clip/a',
          path: firstSource,
          mime_type: 'video/mp4',
          platform_slug: 'social',
          family_id: 'weekly_primary',
        },
        {
          id: 'clip-a',
          path: secondSource,
          mime_type: 'video/mp4',
          platform_slug: 'social',
          family_id: 'weekly_primary',
        },
      ],
    }];

    const result = ingestSocialContentVideoRenderOutput(jobId, output);
    assert.equal(result.ingestedCount, 2);

    const [firstArtifact, secondArtifact] = output[0].artifacts;
    assert.equal(firstArtifact.id, 'clip/a');
    assert.equal(secondArtifact.id, 'clip-a');
    assert.notEqual(firstArtifact.path, secondArtifact.path);
    assert.notEqual(firstArtifact.url, secondArtifact.url);
    assert.equal(await readFile(String(firstArtifact.path), 'utf8'), 'first-clip-bytes');
    assert.equal(await readFile(String(secondArtifact.path), 'utf8'), 'second-clip-bytes');
  });
});

test('stable artifact ids recanonicalize a shared compatibility destination instead of collapsing', async () => {
  await withVideoRuntimeEnv(async ({ videoMount }) => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174028';
    const seedSource = path.join(videoMount, 'compatibility-source.mp4');
    await writeFile(seedSource, 'compatibility-clip-bytes');
    const legacyOutput: Array<{ artifacts: Array<Record<string, unknown>> }> = [{
      artifacts: [{
        path: seedSource,
        mime_type: 'video/mp4',
        platform_slug: 'social',
        family_id: 'weekly_primary',
      }],
    }];
    assert.equal(ingestSocialContentVideoRenderOutput(jobId, legacyOutput).ingestedCount, 1);
    const compatibilityPath = String(legacyOutput[0].artifacts[0].path);

    const output: Array<{ artifacts: Array<Record<string, unknown>> }> = [{
      artifacts: [
        {
          id: 'clip/a',
          path: compatibilityPath,
          mime_type: 'video/mp4',
          platform_slug: 'social',
          family_id: 'weekly_primary',
        },
        {
          id: 'clip-a',
          path: compatibilityPath,
          mime_type: 'video/mp4',
          platform_slug: 'social',
          family_id: 'weekly_primary',
        },
      ],
    }];

    const result = ingestSocialContentVideoRenderOutput(jobId, output);
    assert.equal(result.ingestedCount, 2);
    const [firstArtifact, secondArtifact] = output[0].artifacts;
    assert.notEqual(firstArtifact.path, compatibilityPath);
    assert.notEqual(secondArtifact.path, compatibilityPath);
    assert.notEqual(firstArtifact.path, secondArtifact.path);
    assert.notEqual(firstArtifact.url, secondArtifact.url);
    assert.equal(await readFile(String(firstArtifact.path), 'utf8'), 'compatibility-clip-bytes');
    assert.equal(await readFile(String(secondArtifact.path), 'utf8'), 'compatibility-clip-bytes');
  });
});

test('all-skipped required video output converges marketing, social, and execution state on one terminal failure', async () => {
  await withVideoRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174021';
    const doc = seedVideoJob(jobId);
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-video-all-skipped-consistency',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-video-all-skipped-consistency',
      status: 'requires_approval',
      stage: 'video_render',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'approve_video_render',
        prompt: 'Approve the completed video render.',
      },
      output: [{
        artifacts: [{
          id: 'clip-untrusted',
          path: '/tmp/untrusted-provider-output.mp4',
          mime_type: 'video/mp4',
          platform_slug: 'instagram_reels',
          family_id: 'weekly_primary',
          bytes: 100,
        }],
      }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    assert.equal(after?.state, 'failed');
    assert.equal(after?.status, 'failed');
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'hermes_video_artifact_ingest_failed');
    const socialRuntime = after?.social_content_runtime as {
      stages?: { video_render?: { status?: string; summary?: string } };
    } | undefined;
    assert.equal(socialRuntime?.stages?.video_render?.status, 'failed');
    assert.match(String(socialRuntime?.stages?.video_render?.summary), /without any ingestible/i);

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(executionRecord?.status, 'failed');
    assert.equal(executionRecord?.last_error?.code, 'hermes_video_artifact_ingest_failed');
    assert.notEqual(executionRecord?.status, 'awaiting_approval');
    assert.notEqual(executionRecord?.status, 'completed');
  });
});

test('zero-candidate required video output converges marketing, social, and execution state on one terminal failure', async () => {
  await withVideoRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174023';
    const doc = seedVideoJob(jobId);
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-video-zero-candidate-consistency',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-video-zero-candidate-consistency',
      status: 'requires_approval',
      stage: 'video_render',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'approve_video_render',
        prompt: 'Approve the completed video render.',
      },
      output: [{ artifacts: [] }],
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    assert.equal(after?.state, 'failed');
    assert.equal(after?.status, 'failed');
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'hermes_video_artifact_ingest_failed');
    const socialRuntime = after?.social_content_runtime as {
      stages?: { video_render?: { status?: string; summary?: string } };
    } | undefined;
    assert.equal(socialRuntime?.stages?.video_render?.status, 'failed');
    assert.match(String(socialRuntime?.stages?.video_render?.summary), /without any ingestible/i);

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(executionRecord?.status, 'failed');
    assert.equal(executionRecord?.last_error?.code, 'hermes_video_artifact_ingest_failed');
    assert.notEqual(executionRecord?.status, 'awaiting_approval');
    assert.notEqual(executionRecord?.status, 'completed');
  });
});

test('stopped marketing callback converges marketing and execution state as cancellation', async () => {
  await withVideoRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174024';
    const doc = seedVideoJob(jobId);
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-video-stopped-consistency',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-video-stopped-consistency',
      status: 'stopped',
      stage: 'video_render',
      error: {
        code: 'operator_stopped',
        message: 'The operator stopped video rendering.',
        retryable: false,
      },
    });

    assert.equal(result.status, 'accepted');
    const after = await loadSocialContentJobRuntime(jobId);
    assert.equal(after?.state, 'failed');
    assert.equal(after?.status, 'failed');
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'operator_stopped');

    const executionRecord = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(executionRecord?.status, 'cancelled');
    assert.equal(executionRecord?.last_error?.code, 'operator_stopped');
  });
});

test('rendered-video projection bounds and sanitizes callback-controlled display fields', async () => {
  await withVideoRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174022';
    const doc = seedVideoJob(jobId, 'Tenant-42');
    const runtime = ensureSocialContentRuntimeState(doc);
    runtime.stages.video_render.output = {
      artifacts: [{
        id: 'clip-adversarial',
        path: '/hermes-video-media/tenant-42-private.mp4',
        url: `/api/marketing/jobs/${jobId}/assets/video-safe-clip`,
        mime_type: 'video/mp4',
        platform_slug: '/hermes-video-media/TENANT-42',
        family_id: 'C:\\Users\\tenant-42\\secret',
        title: 'C:\\Users\\tenant-42\\private.mp4',
        summary: '/home/node/.hermes/tenant-42/cache/videos/private.mp4 api_key=super-secret',
        metadata: {
          callback_token: 'do-not-project',
          tenant_id: 'tenant-42',
          mount_root: '/hermes-video-media',
        },
      }],
    };

    const dashboard = buildSocialContentDashboardProjection(doc, emptyDashboard());
    const video = dashboard.assets.find((asset) => asset.type === 'video_ad');
    assert.ok(video);
    assert.equal(video?.previewUrl, `/api/marketing/jobs/${jobId}/assets/video-safe-clip`);
    assert.equal(video?.platform, 'social');
    assert.ok(String(video?.title).length <= 160);
    assert.ok(String(video?.summary).length <= 500);

    const serialized = JSON.stringify(video);
    for (const forbidden of [
      'C:\\',
      '/home/node/.hermes',
      '/hermes-video-media',
      'tenant-42',
      'Tenant-42',
      'super-secret',
      'do-not-project',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `dashboard artifact leaked ${forbidden}`);
    }
  });
});

test('rendered-video projection redacts ordinary single-backslash Windows display paths', async () => {
  await withVideoRuntimeEnv(async () => {
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174027';
    const doc = seedVideoJob(jobId);
    const runtime = ensureSocialContentRuntimeState(doc);
    runtime.stages.video_render.output = {
      artifacts: [{
        id: 'clip-windows-path',
        path: '/hermes-video-media/safe-clip.mp4',
        url: `/api/marketing/jobs/${jobId}/assets/video-safe-clip`,
        mime_type: 'video/mp4',
        platform_slug: 'social',
        family_id: 'weekly_primary',
        title: 'C:\\Operators\\private.mp4',
        summary: 'D:\\Exports\\private-summary.mp4',
      }],
    };

    const dashboard = buildSocialContentDashboardProjection(doc, emptyDashboard());
    const video = dashboard.assets.find((asset) => asset.type === 'video_ad');
    assert.ok(video);
    assert.equal(video.title, 'Social rendered video 1');
    assert.equal(video.summary, 'weekly_primary');
  });
});
