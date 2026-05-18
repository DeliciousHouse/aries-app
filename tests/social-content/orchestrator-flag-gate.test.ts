import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-social-copy-finalize-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    delete process.env.ARIES_SOCIAL_COPY_FINALIZE_ENABLED;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedWeeklySocialDoc(jobId: string, options: { includeApprovedImages?: boolean } = {}) {
  const {
    createMarketingJobRuntimeDocument,
    markStageCompleted,
    saveMarketingJobRuntime,
  } = await import('../../backend/marketing/runtime-state');
  const {
    ensureSocialContentRuntimeState,
    markSocialContentStageCompleted,
  } = await import('../../backend/social-content/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId: 'tenant-social-copy-finalize',
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: 'https://brand.example',
      businessType: 'executive coaching',
      primaryGoal: 'Book consults',
      channels: ['instagram', 'meta'],
    },
    brandKit: {
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
    },
  });

  ensureSocialContentRuntimeState(doc);
  markStageCompleted(doc, 'research', {
    runId: 'research-run-1',
    summary: { summary: 'research complete' },
  });
  markStageCompleted(doc, 'strategy', {
    runId: 'strategy-run-1',
    summary: { summary: 'strategy complete' },
  });
  markStageCompleted(doc, 'production', {
    runId: 'production-run-1',
    summary: { summary: 'production complete' },
    outputs: {
      weekly_content_plan: {
        posts: [
          {
            id: 'post-1',
            channel: 'instagram',
            image: { approved_image_url: 'https://cdn.example.com/post-1.jpg', alt_text: 'Founder portrait' },
          },
        ],
      },
    },
  });
  markSocialContentStageCompleted(doc, 'planning', {
    summary: 'Weekly plan approved.',
    output: {
      weekly_content_plan: {
        posts: [
          {
            id: 'post-1',
            day: 'Day 1',
            platforms: ['instagram'],
            post_type: 'static',
            title: 'Founder story',
            caption: 'Warm founder proof.',
            creative_brief_id: 'creative-post-1',
            status: 'approved',
          },
        ],
      },
    },
  });
  markSocialContentStageCompleted(doc, 'creative_review', {
    summary: 'Creative review approved.',
    output: {
      weekly_content_plan: {
        image_creatives: options.includeApprovedImages === false
          ? []
          : [
              {
                id: 'creative-post-1',
                title: 'Founder portrait',
                prompt: 'Warm executive portrait',
                artifact_url: 'https://cdn.example.com/post-1.jpg',
                alt_text: 'Founder portrait',
                status: 'approved',
              },
            ],
      },
    },
  });
  saveMarketingJobRuntime(doc.job_id, doc);
  return doc;
}

test('continueAfterCreativeReviewApproval preserves the legacy resume path when the finalize flag is off', async () => {
  await withRuntimeEnv(async () => {
    const orchestrator = await import('../../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../../backend/marketing/runtime-state');
    const { readSocialContentRuntimeState } = await import('../../backend/social-content/runtime-state');

    const doc = await seedWeeklySocialDoc('job-social-copy-flag-off');
    let submitterCalled = false;
    const resumeCalls: Array<Record<string, unknown>> = [];

    orchestrator.__setSocialCopyFinalizeSubmitterForTests(async () => {
      submitterCalled = true;
      return { status: 'submitted', ariesRunId: 'arun_should_not_run', hermesRunId: 'hrun_should_not_run' };
    });
    orchestrator.__setMarketingExecutionPortForTests(() => ({
      name: 'hermes',
      runPipeline: async () => {
        throw new Error('not expected');
      },
      submitNextStage: async () => {
        throw new Error('not expected');
      },
      resumePipeline: async (input) => {
        resumeCalls.push(input as unknown as Record<string, unknown>);
        return {
          kind: 'submitted',
          provider: 'hermes',
          ariesRunId: 'arun_resume_publish_review',
          hermesRunId: 'hrun_resume_publish_review',
        };
      },
    }));

    try {
      const resumedStage = await orchestrator.__continueAfterCreativeReviewApprovalForTests(doc, 'resume-token-off', {
        approvalStep: 'approve_image_creatives',
        workflowKey: 'social_content_weekly',
      });
      assert.equal(resumedStage, 'publish');
    } finally {
      orchestrator.__setSocialCopyFinalizeSubmitterForTests(null);
      orchestrator.__setMarketingExecutionPortForTests(null);
    }

    assert.equal(submitterCalled, false);
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0]?.resumeToken, 'resume-token-off');

    const reloaded = await loadMarketingJobRuntime(doc.job_id);
    const socialRuntime = reloaded && readSocialContentRuntimeState(reloaded);
    assert.equal(socialRuntime?.stages.social_copy_finalize.status, 'completed');
    assert.equal(
      (socialRuntime?.stages.social_copy_finalize.output as Record<string, unknown> | null)?.reason,
      'feature_flag_disabled',
    );
  });
});

test('continueAfterCreativeReviewApproval submits social copy finalize when the flag is on', async () => {
  await withRuntimeEnv(async () => {
    process.env.ARIES_SOCIAL_COPY_FINALIZE_ENABLED = '1';

    const orchestrator = await import('../../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime, getStageRecord } = await import('../../backend/marketing/runtime-state');
    const { readSocialContentRuntimeState } = await import('../../backend/social-content/runtime-state');

    const doc = await seedWeeklySocialDoc('job-social-copy-flag-on');
    let submitterCalls = 0;

    orchestrator.__setSocialCopyFinalizeSubmitterForTests(async () => {
      submitterCalls += 1;
      return {
        status: 'submitted',
        ariesRunId: 'arun_social_copy_finalize_1',
        hermesRunId: 'hrun_social_copy_finalize_1',
      };
    });

    try {
      const resumedStage = await orchestrator.__continueAfterCreativeReviewApprovalForTests(doc, 'resume-token-on', {
        approvalStep: 'approve_image_creatives',
        workflowKey: 'social_content_weekly',
      });
      assert.equal(resumedStage, 'production');
    } finally {
      orchestrator.__setSocialCopyFinalizeSubmitterForTests(null);
    }

    assert.equal(submitterCalls, 1);

    const reloaded = await loadMarketingJobRuntime(doc.job_id);
    assert.ok(reloaded);
    if (!reloaded) return;

    const production = getStageRecord(reloaded, 'production');
    assert.equal(production.outputs.social_copy_finalize_aries_run_id, 'arun_social_copy_finalize_1');
    assert.equal(production.outputs.social_copy_finalize_status, 'submitted');
    const socialRuntime = readSocialContentRuntimeState(reloaded);
    assert.equal(socialRuntime?.stages.social_copy_finalize.status, 'running');
  });
});

test('continueAfterCreativeReviewApproval skips the finalize submission when the request builder finds no approved images', async () => {
  await withRuntimeEnv(async () => {
    process.env.ARIES_SOCIAL_COPY_FINALIZE_ENABLED = '1';

    const orchestrator = await import('../../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime } = await import('../../backend/marketing/runtime-state');
    const { readSocialContentRuntimeState } = await import('../../backend/social-content/runtime-state');

    const doc = await seedWeeklySocialDoc('job-social-copy-no-images', { includeApprovedImages: false });
    const resumeCalls: Array<Record<string, unknown>> = [];

    orchestrator.__setMarketingExecutionPortForTests(() => ({
      name: 'hermes',
      runPipeline: async () => {
        throw new Error('not expected');
      },
      submitNextStage: async () => {
        throw new Error('not expected');
      },
      resumePipeline: async (input) => {
        resumeCalls.push(input as unknown as Record<string, unknown>);
        return {
          kind: 'submitted',
          provider: 'hermes',
          ariesRunId: 'arun_resume_publish_review',
          hermesRunId: 'hrun_resume_publish_review',
        };
      },
    }));

    try {
      const resumedStage = await orchestrator.__continueAfterCreativeReviewApprovalForTests(doc, 'resume-token-skip', {
        approvalStep: 'approve_image_creatives',
        workflowKey: 'social_content_weekly',
      });
      assert.equal(resumedStage, 'publish');
    } finally {
      orchestrator.__setMarketingExecutionPortForTests(null);
    }

    assert.equal(resumeCalls.length, 1);

    const reloaded = await loadMarketingJobRuntime(doc.job_id);
    const socialRuntime = reloaded && readSocialContentRuntimeState(reloaded);
    assert.equal(socialRuntime?.stages.social_copy_finalize.status, 'completed');
    assert.equal(
      (socialRuntime?.stages.social_copy_finalize.output as Record<string, unknown> | null)?.reason,
      'no_approved_images',
    );
  });
});
