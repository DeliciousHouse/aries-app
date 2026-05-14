import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-hermes-callback-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedMarketingJob() {
  const {
    createMarketingJobRuntimeDocument,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId: 'job-hermes-callback',
    tenantId: 'tenant-hermes',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'performance marketing agency',
      competitorUrl: 'https://betterup.com',
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
    },
  });
  saveMarketingJobRuntime(doc.job_id, doc);
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
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
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

    const afterResearch = await loadMarketingJobRuntime(doc.job_id);
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
    assert.equal(strategyApproval?.lobster_resume_token, undefined);
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

    const afterLateRunning = await loadMarketingJobRuntime(doc.job_id);
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

    const afterPublish = await loadMarketingJobRuntime(doc.job_id);
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
    const afterLateFailure = await loadMarketingJobRuntime(doc.job_id);
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
    const afterLateCancellation = await loadMarketingJobRuntime(doc.job_id);
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

test('Hermes media setup failures move social content jobs to needs_connection', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
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

    const afterFailure = await loadMarketingJobRuntime(doc.job_id);
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
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const hermesCacheRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-video-cache-'));
    const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
    const doc = await seedMarketingJob();

    try {
      process.env.HERMES_CACHE_DIR = hermesCacheRoot;
      const videoPath = path.join(hermesCacheRoot, 'run-1', 'launch-cut.mp4');
      const posterPath = path.join(hermesCacheRoot, 'run-1', 'launch-cut.png');
      await mkdir(path.dirname(videoPath), { recursive: true });
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

      const after = await loadMarketingJobRuntime(doc.job_id);
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

test('Hermes one-shot multi-stage completion fans out into all four marketing stages', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
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

    const after = await loadMarketingJobRuntime(doc.job_id);
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
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
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

    const runtime = (await loadMarketingJobRuntime(doc.job_id))?.social_content_runtime as {
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
