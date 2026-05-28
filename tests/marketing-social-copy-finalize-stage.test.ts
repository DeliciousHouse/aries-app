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

async function seedWeeklySocialDoc(jobId: string) {
  const {
    createSocialContentJobRuntimeDocument,
    markStageCompleted,
    saveSocialContentJobRuntime,
  } = await import('../backend/marketing/runtime-state');
  const {
    ensureSocialContentRuntimeState,
    markSocialContentStageCompleted,
  } = await import('../backend/social-content/runtime-state');

  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId: 'tenant-social-copy-finalize',
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: 'https://brand.example',
      businessType: 'executive coaching',
      primaryGoal: 'Book consults',
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
  markSocialContentStageCompleted(doc, 'creative_review', {
    summary: 'Creative review approved.',
  });
  saveSocialContentJobRuntime(doc.job_id, doc);
  return doc;
}

test('continueAfterCreativeReviewApproval preserves legacy resume path when finalize flag is off', async () => {
  await withRuntimeEnv(async () => {
    const orchestrator = await import('../backend/marketing/orchestrator');
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const { readSocialContentRuntimeState } = await import('../backend/social-content/runtime-state');

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
      getCallbackUrl: () => 'https://aries.example.com/api/internal/hermes/runs',
      getSessionKey: () => 'marketing',
      submitRawRun: async () => { throw new Error('not expected'); },
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

    assert.equal(submitterCalled, false, 'flag-off path must not submit social copy finalize');
    assert.equal(resumeCalls.length, 1, 'legacy production resume should still run once');
    assert.equal(resumeCalls[0]?.resumeToken, 'resume-token-off');
    assert.equal(resumeCalls[0]?.stage, 'production');

    const reloaded = await loadSocialContentJobRuntime(doc.job_id);
    assert.ok(reloaded, 'runtime doc should persist');
    if (!reloaded) return;
    const socialRuntime = readSocialContentRuntimeState(reloaded);
    assert.ok(socialRuntime, 'social runtime should be present');
    assert.equal(socialRuntime?.stages.social_copy_finalize.status, 'completed');
    assert.equal(
      (socialRuntime?.stages.social_copy_finalize.output as Record<string, unknown> | null)?.reason,
      'feature_flag_disabled',
    );
  });
});

test('continueAfterCreativeReviewApproval submits social copy finalize when flag is on', async () => {
  await withRuntimeEnv(async () => {
    process.env.ARIES_SOCIAL_COPY_FINALIZE_ENABLED = '1';

    const orchestrator = await import('../backend/marketing/orchestrator');
    const { loadSocialContentJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');
    const { readSocialContentRuntimeState } = await import('../backend/social-content/runtime-state');

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

    assert.equal(submitterCalls, 1, 'finalize submission should happen exactly once');

    const reloaded = await loadSocialContentJobRuntime(doc.job_id);
    assert.ok(reloaded, 'runtime doc should persist');
    if (!reloaded) return;

    const production = getStageRecord(reloaded, 'production');
    assert.equal(production.outputs.social_copy_finalize_aries_run_id, 'arun_social_copy_finalize_1');
    assert.equal(production.outputs.social_copy_finalize_hermes_run_id, 'hrun_social_copy_finalize_1');
    assert.equal(production.outputs.social_copy_finalize_status, 'submitted');

    const socialRuntime = readSocialContentRuntimeState(reloaded);
    assert.ok(socialRuntime, 'social runtime should be present');
    assert.equal(socialRuntime?.stages.social_copy_finalize.status, 'running');
    assert.equal(
      (socialRuntime?.stages.social_copy_finalize.output as Record<string, unknown> | null)?.workflow_key,
      'social_copy_finalize',
    );
  });
});
