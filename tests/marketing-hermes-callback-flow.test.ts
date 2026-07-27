import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-hermes-callback-'));

  process.env.DATA_ROOT = dataRoot;
  process.env.HERMES_CACHE_DIR = path.join(dataRoot, 'hermes-cache');
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousHermesCacheDir === undefined) delete process.env.HERMES_CACHE_DIR;
    else process.env.HERMES_CACHE_DIR = previousHermesCacheDir;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedMarketingJob(options: { jobId?: string; videoRenderCount?: number } = {}) {
  const {
    createSocialContentJobRuntimeDocument,
    saveSocialContentJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createSocialContentJobRuntimeDocument({
    jobId: options.jobId ?? 'job-hermes-callback',
    tenantId: 'tenant-hermes',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'performance marketing agency',
      competitorUrl: 'https://betterup.com',
      jobType: 'weekly_social_content',
      videoRenderCount: options.videoRenderCount ?? 0,
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: {
        primary: null,
        secondary: null,
        accent: null,
        palette: [],
      },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'clear',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });
  saveSocialContentJobRuntime(doc.job_id, doc);
  return doc;
}

test('Hermes marketing callbacks advance runtime docs and create provider-neutral approvals', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const {
      listMarketingApprovalRecordsForJob,
      loadMarketingApprovalRecord,
    } = await import('../backend/marketing/approval-store');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob();

    const researchRun = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'research',
    });

    const researchResult = await handleHermesRunCallback({
      event_id: 'evt-research',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'requires_approval',
      stage: 'planning',
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'plan',
        approval_step: 'approve_weekly_plan',
        workflow_step_id: 'approve_stage_2',
        prompt: 'Approve strategy?',
        resume_token: 'hermes-resume-strategy',
      },
    });
    const duplicateResearchResult = await handleHermesRunCallback({
      event_id: 'evt-research',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'requires_approval',
      stage: 'planning',
      output: [{ run_id: 'research-run-1', summary: 'Research complete' }],
      approval: {
        stage: 'plan',
        approval_step: 'approve_weekly_plan',
        workflow_step_id: 'approve_stage_2',
        prompt: 'Approve strategy?',
        resume_token: 'hermes-resume-strategy',
      },
    });

    assert.deepEqual(researchResult, {
      status: 'accepted',
      ariesRunId: researchRun.aries_run_id,
      duplicate: false,
    });
    assert.deepEqual(duplicateResearchResult, {
      status: 'accepted',
      ariesRunId: researchRun.aries_run_id,
      duplicate: true,
    });

    const afterResearch = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterResearch?.stages.research.status, 'completed');
    assert.equal(afterResearch?.approvals.current?.stage, 'strategy');
    assert.equal(afterResearch?.approvals.current?.workflow_step_id, 'approve_stage_2');
    assert.equal(afterResearch?.approvals.current?.resume_token, 'hermes-resume-strategy');
    assert.equal(afterResearch?.social_content_runtime?.currentStage, 'plan_review');
    assert.equal(
      (afterResearch?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.planning?.status,
      'completed',
    );
    assert.equal(
      (afterResearch?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.plan_review?.status,
      'awaiting_approval',
    );

    const strategyApproval = loadMarketingApprovalRecord(afterResearch?.approvals.current?.approval_id ?? '');
    assert.equal(strategyApproval?.execution_provider, 'hermes');
    assert.equal(strategyApproval?.execution_resume_token, 'hermes-resume-strategy');
    assert.equal(strategyApproval?.social_content_approval_step, 'approve_weekly_plan');
    assert.equal(listMarketingApprovalRecordsForJob(doc.job_id).length, 1);
    assert.deepEqual(loadExecutionRunRecord(researchRun.aries_run_id)?.result, [
      {
        run_id: 'research-run-1',
        summary: 'Research complete',
      },
    ]);

    await handleHermesRunCallback({
      event_id: 'evt-research-running-late',
      aries_run_id: researchRun.aries_run_id,
      hermes_run_id: 'hermes-research-1',
      status: 'running',
      stage: 'research',
      output: [{ run_id: 'research-run-1', summary: 'Late running callback should be ignored' }],
    });

    const afterLateRunning = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterLateRunning?.stages.research.status, 'completed');
    assert.equal(afterLateRunning?.social_content_runtime?.currentStage, 'plan_review');

    const publishRun = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'publish',
      workflowStepId: 'approve_stage_4_publish',
      approvalId: afterResearch?.approvals.current?.approval_id,
    });

    await handleHermesRunCallback({
      event_id: 'evt-publish',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'completed',
      stage: 'publish_review',
      output: [{ run_id: 'publish-run-1', summary: 'Published' }],
    });

    const afterPublish = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterPublish?.stages.publish.status, 'completed');
    assert.equal(afterPublish?.state, 'completed');
    assert.equal(afterPublish?.status, 'completed');
    assert.equal(afterPublish?.approvals.current, null);
    assert.equal(afterPublish?.social_content_runtime?.currentStage, 'completed');
    assert.equal(
      (afterPublish?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.completed?.status,
      'completed',
    );

    await handleHermesRunCallback({
      event_id: 'evt-publish-failed-late',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'failed',
      stage: 'publish_review',
      error: {
        code: 'late_failure',
        message: 'Late failure should not regress completed runtime state.',
      },
    });
    const afterLateFailure = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterLateFailure?.state, 'completed');
    assert.equal(afterLateFailure?.status, 'completed');
    assert.equal(afterLateFailure?.stages.publish.status, 'completed');
    assert.equal(afterLateFailure?.last_error, null);
    assert.equal(afterLateFailure?.social_content_runtime?.currentStage, 'completed');

    await handleHermesRunCallback({
      event_id: 'evt-publish-cancelled-late',
      aries_run_id: publishRun.aries_run_id,
      hermes_run_id: 'hermes-publish-1',
      status: 'cancelled',
      stage: 'publish_review',
      error: {
        code: 'late_cancelled',
        message: 'Late cancellation should not regress completed runtime state.',
      },
    });
    const afterLateCancellation = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterLateCancellation?.state, 'completed');
    assert.equal(afterLateCancellation?.status, 'completed');
    assert.equal(afterLateCancellation?.stages.publish.status, 'completed');
    assert.equal(afterLateCancellation?.last_error, null);
    assert.equal(afterLateCancellation?.social_content_runtime?.currentStage, 'completed');
  });
});

test('execution run records ignore late terminal callbacks after completion', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'route',
      workflowKey: 'demo_start',
      action: 'run',
      tenantId: 'tenant-terminal',
    });

    await handleHermesRunCallback({
      event_id: 'evt-run-completed',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'completed',
      output: [{ ok: true }],
    });

    const completed = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(completed?.status, 'completed');
    assert.deepEqual(completed?.result, [{ ok: true }]);
    assert.equal(completed?.last_error, null);

    await handleHermesRunCallback({
      event_id: 'evt-run-failed-late',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'failed',
      output: [{ ok: false }],
      error: {
        code: 'late_failed',
        message: 'Late failure should not mutate completed run.',
      },
    });

    const afterLateFailed = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(afterLateFailed?.status, 'completed');
    assert.deepEqual(afterLateFailed?.result, [{ ok: true }]);
    assert.equal(afterLateFailed?.last_error, null);

    await handleHermesRunCallback({
      event_id: 'evt-run-cancelled-late',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-terminal-1',
      status: 'cancelled',
      output: [{ ok: 'cancelled' }],
      error: {
        code: 'late_cancelled',
        message: 'Late cancellation should not mutate completed run.',
      },
    });

    const afterLateCancelled = loadExecutionRunRecord(run.aries_run_id);
    assert.equal(afterLateCancelled?.status, 'completed');
    assert.deepEqual(afterLateCancelled?.result, [{ ok: true }]);
    assert.equal(afterLateCancelled?.last_error, null);
    assert.deepEqual(afterLateCancelled?.event_ids, [
      'evt-run-completed',
      'evt-run-failed-late',
      'evt-run-cancelled-late',
    ]);
  });
});

test('execution run records reject every transition out of every terminal origin', async () => {
  await withRuntimeEnv(async () => {
    const {
      createExecutionRunRecord,
      loadExecutionRunRecord,
      markExecutionRunEventApplied,
    } = await import('../backend/execution/run-store');
    const terminalOrigins = ['completed', 'failed', 'cancelled'] as const;
    const attemptedTargets = ['submitted', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;

    for (const origin of terminalOrigins) {
      const run = createExecutionRunRecord({
        provider: 'hermes',
        domain: 'route',
        workflowKey: 'terminal_transition_matrix',
        action: 'run',
        tenantId: 'tenant-terminal-matrix',
      });
      markExecutionRunEventApplied(run.aries_run_id, {
        eventId: `evt-origin-${origin}`,
        status: origin,
        result: { origin },
      });

      for (const target of attemptedTargets) {
        markExecutionRunEventApplied(run.aries_run_id, {
          eventId: `evt-${origin}-to-${target}`,
          status: target,
          result: { target },
        });
        const record = loadExecutionRunRecord(run.aries_run_id);
        assert.equal(record?.status, origin, `${origin} must not transition to ${target}`);
        assert.deepEqual(record?.result, { origin });
      }
    }
  });
});

test('Hermes media setup failures move social content jobs to needs_connection', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: 'evt-media-setup-required',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-media-setup-1',
      status: 'failed',
      stage: 'image_creatives',
      error: {
        code: 'hermes_media_setup_required',
        message: 'Hermes media setup must be completed before image generation can continue.',
        retryable: true,
      },
    });

    const afterFailure = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(afterFailure?.state, 'needs_connection');
    assert.equal(afterFailure?.status, 'needs_connection');
    assert.equal(afterFailure?.current_stage, 'production');
    assert.equal(afterFailure?.last_error?.code, 'hermes_media_setup_required');
    assert.match(afterFailure?.last_error?.message ?? '', /Hermes media setup/i);
    assert.equal(afterFailure?.stages.production.status, 'not_started');
    assert.equal(
      (afterFailure?.social_content_runtime as { stages?: Record<string, { status?: string }> } | undefined)
        ?.stages?.image_generation?.status,
      'failed',
    );
  });
});

test('Hermes video_render callbacks ingest rendered media from the Hermes cache into DATA_ROOT job videos', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const hermesCacheRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-video-cache-'));
    const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
    const doc = await seedMarketingJob();

    try {
      process.env.HERMES_CACHE_DIR = hermesCacheRoot;
      const videoPath = path.join(hermesCacheRoot, 'cache', 'videos', 'run-1', 'launch-cut.mp4');
      const posterPath = path.join(hermesCacheRoot, 'cache', 'images', 'run-1', 'launch-cut.png');
      await mkdir(path.dirname(videoPath), { recursive: true });
      await mkdir(path.dirname(posterPath), { recursive: true });
      await writeFile(videoPath, Buffer.from('callback-video'));
      await writeFile(posterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const run = createExecutionRunRecord({
        provider: 'hermes',
        domain: 'marketing',
        workflowKey: 'social_content_weekly',
        action: 'resume',
        tenantId: doc.tenant_id,
        marketingJobId: doc.job_id,
        stage: 'production',
      });

      await handleHermesRunCallback({
        event_id: 'evt-video-render',
        aries_run_id: run.aries_run_id,
        hermes_run_id: 'hermes-video-render-1',
        status: 'requires_approval',
        stage: 'video_render',
        output: [{
          summary: 'Video render finished',
          video_assets: {
            platform_contracts: [{
              platform_slug: 'tiktok',
              rendered_video_variants: [{
                family_id: 'launch-cut',
                video_path: videoPath,
                thumbnail_path: posterPath,
              }],
            }],
          },
        }],
        approval: {
          stage: 'video',
          approval_step: 'approve_video_render',
          workflow_step_id: 'approve_video_render',
          prompt: 'Approve render?',
          resume_token: 'resume-render',
        },
      });

      const after = await loadSocialContentJobRuntime(doc.job_id);
      const output = after?.stages.production.primary_output as Record<string, unknown> | null;
      const variant = (((output?.video_assets as Record<string, unknown> | undefined)?.platform_contracts as Array<Record<string, unknown>> | undefined)?.[0]
        ?.rendered_video_variants as Array<Record<string, unknown>> | undefined)?.[0];
      const ingestedVideoPath = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'jobs', doc.job_id, 'videos', 'tiktok-launch-cut.mp4');
      const ingestedPosterPath = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'jobs', doc.job_id, 'videos', 'tiktok-launch-cut-poster.png');

      assert.equal(variant?.video_path, ingestedVideoPath);
      assert.equal(variant?.poster_path, ingestedPosterPath);
      assert.deepEqual(await readFile(ingestedVideoPath), Buffer.from('callback-video'));
      assert.deepEqual(await readFile(ingestedPosterPath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      if (previousHermesCacheDir === undefined) delete process.env.HERMES_CACHE_DIR;
      else process.env.HERMES_CACHE_DIR = previousHermesCacheDir;
      await rm(hermesCacheRoot, { recursive: true, force: true });
    }
  });
});

test('Hermes video_render callback skip logs omit full filesystem paths', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const hermesCacheRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-video-cache-'));
    const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
    const previousWarn = console.warn;
    const warnings: unknown[][] = [];
    const doc = await seedMarketingJob();

    try {
      process.env.HERMES_CACHE_DIR = hermesCacheRoot;
      const leakedPosterPath = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'jobs', 'other-job', 'videos', 'tiktok-launch-cut-poster.png');
      await mkdir(path.dirname(leakedPosterPath), { recursive: true });
      await writeFile(leakedPosterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };

      const run = createExecutionRunRecord({
        provider: 'hermes',
        domain: 'marketing',
        workflowKey: 'social_content_weekly',
        action: 'resume',
        tenantId: doc.tenant_id,
        marketingJobId: doc.job_id,
        stage: 'production',
      });

      await handleHermesRunCallback({
        event_id: 'evt-video-render-skip-log',
        aries_run_id: run.aries_run_id,
        hermes_run_id: 'hermes-video-render-skip-log',
        status: 'requires_approval',
        stage: 'video_render',
        output: [{
          summary: 'Video render finished',
          video_assets: {
            platform_contracts: [{
              platform_slug: 'tiktok',
              rendered_video_variants: [{
                family_id: 'launch-cut',
                thumbnail_path: leakedPosterPath,
              }],
            }],
          },
        }],
        approval: {
          stage: 'video',
          approval_step: 'approve_video_render',
          workflow_step_id: 'approve_video_render',
          prompt: 'Approve render?',
          resume_token: 'resume-render',
        },
      });

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.[0], '[social-content-video-ingest] skipped media during Hermes callback ingest');
      assert.deepEqual(warnings[0]?.[1], {
        jobId: doc.job_id,
        skipped: {
          count: 1,
          reasons: { not_allowed: 1 },
        },
      });
    } finally {
      console.warn = previousWarn;
      if (previousHermesCacheDir === undefined) delete process.env.HERMES_CACHE_DIR;
      else process.env.HERMES_CACHE_DIR = previousHermesCacheDir;
      await rm(hermesCacheRoot, { recursive: true, force: true });
    }
  });
});

test('Hermes one-shot multi-stage completion fans out into all four marketing stages', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'research',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-oneshot',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-oneshot-1',
      status: 'completed',
      output: [
        { stage: 'research', run_id: 'rs-1', summary: 'Research done' },
        { stage: 'strategy', run_id: 'st-1', summary: 'Strategy done' },
        { stage: 'production', run_id: 'pr-1', summary: 'Production done' },
        { stage: 'publish', run_id: 'pb-1', summary: 'Publish done' },
      ],
    });

    assert.deepEqual(result, {
      status: 'accepted',
      ariesRunId: run.aries_run_id,
      duplicate: false,
    });

    const after = await loadSocialContentJobRuntime(doc.job_id);
    assert.equal(after?.stages.research.status, 'completed');
    assert.equal(after?.stages.research.run_id, 'rs-1');
    assert.equal(after?.stages.research.summary?.summary, 'Research done');
    assert.equal(after?.stages.strategy.status, 'completed');
    assert.equal(after?.stages.strategy.run_id, 'st-1');
    assert.equal(after?.stages.strategy.summary?.summary, 'Strategy done');
    assert.equal(after?.stages.production.status, 'completed');
    assert.equal(after?.stages.production.run_id, 'pr-1');
    assert.equal(after?.stages.production.summary?.summary, 'Production done');
    assert.equal(after?.stages.publish.status, 'completed');
    assert.equal(after?.stages.publish.run_id, 'pb-1');
    assert.equal(after?.stages.publish.summary?.summary, 'Publish done');
    assert.equal(after?.state, 'completed');
    assert.equal(after?.status, 'completed');
    assert.equal(after?.current_stage, 'publish');
    assert.equal(after?.approvals.current, null);
  });
});

test('Hermes one-shot multi-stage completion advances social-content runtime stages too', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await seedMarketingJob();

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: doc.job_id,
      stage: 'research',
    });

    await handleHermesRunCallback({
      event_id: 'evt-social-oneshot',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-social-oneshot-1',
      status: 'completed',
      output: [
        { stage: 'research', run_id: 'rs-social-1', summary: 'Research done' },
        { stage: 'strategy', run_id: 'st-social-1', summary: 'Plan done' },
        { stage: 'production', run_id: 'pr-social-1', summary: 'Copy done' },
        { stage: 'publish', run_id: 'pb-social-1', summary: 'Publish done' },
      ],
    });

    const runtime = (await loadSocialContentJobRuntime(doc.job_id))?.social_content_runtime as {
      currentStage?: string;
      stages?: Record<string, { status?: string }>;
    } | undefined;
    assert.equal(runtime?.currentStage, 'completed');
    assert.equal(runtime?.stages?.research?.status, 'completed');
    assert.equal(runtime?.stages?.planning?.status, 'completed');
    assert.equal(runtime?.stages?.copy_production?.status, 'completed');
    assert.equal(runtime?.stages?.publish_review?.status, 'completed');
    assert.equal(runtime?.stages?.completed?.status, 'completed');
  });
});

test('provider-neutral video run crosses submission, authenticated callback, durable ingestion, and dashboard projection', async () => {
  await withRuntimeEnv(async () => {
    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const { parseHermesRunCallbackPayload, handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { hashCallbackToken, verifyCallbackToken, verifyInternalCallbackRequest } = await import('../lib/internal-callback-auth');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const { buildSocialContentDashboardProjection } = await import('../backend/social-content/dashboard-projection');
    const { validateVideoRenderHermesSubmission } = await import('../backend/video-runtime/hermes-contract');
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');

    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174000';
    const doc = await seedMarketingJob({ jobId, videoRenderCount: 1 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ run_id: 'hermes-video-runtime-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    };
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: 'https://hermes.example.com',
        HERMES_API_SERVER_KEY: 'test-key',
        HERMES_POLL_BRIDGE_ENABLED: '0',
        INTERNAL_API_SECRET: 'internal-video-secret',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
      async () => {},
      async () => ({ refreshed: false, enriched: false }),
    );

    const submitted = await port.submitNextStage({
      jobId,
      tenantId: doc.tenant_id,
      doc,
      stage: 'production',
    });
    assert.equal(submitted.kind, 'submitted');
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.equal(body.job_id, jobId);
    const validated = validateVideoRenderHermesSubmission(body);
    assert.equal(validated.job_id, jobId);
    assert.equal(JSON.stringify(body).includes('media_provider'), false);

    const source = path.join(
      process.env.HERMES_CACHE_DIR as string,
      'cache',
      'videos',
      'video_render_20260727_integration.mp4',
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, Buffer.from('integration-video'));

    const callbackToken = String((body.callback_auth as Record<string, unknown>).callback_token);
    const callbackPayload = {
      event_id: 'evt-video-runtime-integration',
      aries_run_id: submitted.kind === 'submitted' ? submitted.ariesRunId : '',
      hermes_run_id: 'hermes-video-runtime-1',
      status: 'requires_approval',
      stage: 'video_render',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'approve_stage_3',
        prompt: 'Review the rendered video.',
        resume_token: 'video-runtime-review-token',
      },
      output: [{
        artifacts: [{
          id: 'clip-primary',
          path: source,
          mime_type: 'video/mp4',
          platform_slug: 'instagram_reels',
          family_id: 'weekly_primary',
          width: 1080,
          height: 1920,
          duration_seconds: 6,
          bytes: 17,
        }],
      }],
    };
    const parsedCallback = parseHermesRunCallbackPayload(callbackPayload);
    if (!parsedCallback) {
      throw new Error('expected video callback to satisfy the shared Hermes callback schema');
    }
    const request = new Request('https://aries.example.com/api/internal/hermes/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer internal-video-secret',
        'x-aries-callback-token': callbackToken,
      },
    });
    assert.deepEqual(verifyInternalCallbackRequest(request, { INTERNAL_API_SECRET: 'internal-video-secret' }), { ok: true });
    assert.deepEqual(await verifyCallbackToken(parsedCallback.aries_run_id, callbackToken, {
      async query(_sql: string, params: unknown[]) {
        assert.equal(params[0], hashCallbackToken(callbackToken));
        return {
          rows: [{ token_hash: hashCallbackToken(callbackToken), aries_run_id: parsedCallback.aries_run_id }],
          rowCount: 1,
        };
      },
    }), { ok: true });

    const callbackResult = await handleHermesRunCallback(parsedCallback);
    assert.equal(callbackResult.status, 'accepted', JSON.stringify(callbackResult));
    const after = await loadSocialContentJobRuntime(jobId);
    const videoOutput = (after?.social_content_runtime as {
      stages?: Record<string, { output?: { artifacts?: Array<Record<string, unknown>> } }>;
    } | undefined)?.stages?.video_render?.output;
    assert.ok(videoOutput?.artifacts?.[0]);
    assert.match(String(videoOutput.artifacts[0].path), /instagram-reels-weekly-primary\.mp4$/);
    assert.equal(
      videoOutput.artifacts[0].url,
      `/api/marketing/jobs/${jobId}/assets/video-instagram-reels-weekly-primary`,
    );

    const dashboard = buildSocialContentDashboardProjection(after!, {
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
    });
    const dashboardVideo = dashboard.assets.find((asset) => asset.type === 'video_ad');
    assert.ok(dashboardVideo, 'expected a dashboard-visible video asset');
    assert.equal(dashboardVideo?.previewUrl, videoOutput.artifacts[0].url);
    const assetId = String(dashboardVideo?.previewUrl).split('/').at(-1) as string;
    const assetResponse = await handleGetMarketingJobAsset(
      jobId,
      assetId,
      new Request(`https://aries.example.com${dashboardVideo?.previewUrl}`),
      async () => ({
        userId: 'user-video-integration',
        tenantId: doc.tenant_id,
        tenantSlug: 'tenant-hermes',
        role: 'tenant_admin',
      }),
    );
    assert.equal(assetResponse.status, 200);
    assert.equal(Buffer.from(await assetResponse.arrayBuffer()).toString('utf8'), 'integration-video');
  });
});

test('retryable failed video callback preserves completed partial artifacts before surfacing the failure', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174002';
    const doc = await seedMarketingJob({ jobId, videoRenderCount: 2 });
    const source = path.join(process.env.HERMES_CACHE_DIR as string, 'cache', 'videos', 'partial.mp4');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, Buffer.from('partial-video'));
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: doc.tenant_id,
      marketingJobId: jobId,
      stage: 'production',
    });

    await handleHermesRunCallback({
      event_id: 'evt-video-partial-rate-limit',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-video-partial',
      status: 'failed',
      stage: 'video_render',
      output: [{
        artifacts: [{
          id: 'partial-primary',
          path: source,
          mime_type: 'video/mp4',
          platform_slug: 'tiktok',
          family_id: 'partial_primary',
          bytes: 13,
        }],
      }],
      error: {
        code: 'rate_limited',
        message: 'One render completed before the retryable rate limit.',
        retryable: true,
      },
    });

    const after = await loadSocialContentJobRuntime(jobId);
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'rate_limited');
    const output = (after?.social_content_runtime as {
      stages?: Record<string, { output?: { artifacts?: Array<Record<string, unknown>> } }>;
    } | undefined)?.stages?.video_render?.output;
    assert.match(String(output?.artifacts?.[0]?.path), /tiktok-partial-primary\.mp4$/);
    assert.equal(await readFile(String(output?.artifacts?.[0]?.path), 'utf8'), 'partial-video');
  });
});

test('successful video callback fails loudly when every reported artifact is outside the ingestion allowlist', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');

    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174003';
    const doc = await seedMarketingJob({ jobId, videoRenderCount: 1 });
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      marketingJobId: jobId,
      tenantId: doc.tenant_id,
      stage: 'production',
    });

    const result = await handleHermesRunCallback({
      event_id: 'evt-video-all-skipped',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hrun-video-all-skipped',
      status: 'requires_approval',
      stage: 'video_render',
      approval: {
        stage: 'publish',
        approval_step: 'approve_video_render',
        workflow_step_id: 'video-render-all-skipped',
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
    assert.equal(after?.stages.production.status, 'failed');
    assert.equal(after?.last_error?.code, 'hermes_video_artifact_ingest_failed');
    const socialRuntime = after?.social_content_runtime as {
      stages?: { video_render?: { status?: string; summary?: string } };
    } | undefined;
    assert.equal(socialRuntime?.stages?.video_render?.status, 'failed');
    assert.match(String(socialRuntime?.stages?.video_render?.summary), /without any ingestible/i);
  });
});
