import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } from '../backend/marketing/runtime-state';
import { createExecutionRunRecord } from '../backend/execution/run-store';
import { PROTOCOL_VERSION } from '@aries/hermes-protocol';

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

function videoDoc(jobId: string) {
  return createSocialContentJobRuntimeDocument({
    jobId,
    tenantId: 'tenant-video-port',
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
}

function createPort(calls: Array<{ url: string; init: RequestInit }>) {
  return new HermesMarketingPort(
    {
      HERMES_GATEWAY_URL: 'https://hermes.example.com',
      HERMES_API_SERVER_KEY: 'test-key',
      HERMES_POLL_BRIDGE_ENABLED: '0',
      INTERNAL_API_SECRET: 'internal-secret',
      APP_BASE_URL: 'https://aries.example.com',
    },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ run_id: 'hermes-video-port-test', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {},
    async () => ({ refreshed: false, enriched: false }),
  );
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-port-validation-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('live submit chokepoint rejects required video work with malformed or non-production job IDs before fetch', async () => {
  await withDataRoot(async () => {
    for (const jobId of ['job_non_production_video', 'mkt_placeholder']) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const port = createPort(calls);
      const doc = videoDoc(jobId);

      await assert.rejects(
        port.submitNextStage({
          jobId,
          tenantId: doc.tenant_id,
          doc,
          stage: 'production',
        }),
        /production mkt_<uuid>/i,
      );
      assert.equal(calls.length, 0, `invalid ${jobId} must not reach Hermes`);
    }
  });
});

test('live raw submit validates provider-neutral video payload before shared parsing strips unknown fields', async () => {
  await withDataRoot(async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const port = createPort(calls);
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174010';
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: 'tenant-video-port',
      marketingJobId: jobId,
      stage: 'production',
    });
    const payload = {
      input: 'Request (JSON): {"input":{"media_requests":[{"type":"video.generate","count":1}]}}',
      workflow_key: 'social_content_weekly',
      action: 'run',
      aries_run_id: run.aries_run_id,
      job_id: jobId,
      tenant_id: 'tenant-video-port',
      callback_url: 'https://aries.example.com/api/internal/hermes/runs',
      callback_auth: {
        type: 'internal_api_secret_bearer',
        secret_ref: 'INTERNAL_API_SECRET',
        callback_token: 'a'.repeat(64),
      },
      callback_context: {
        workflow_key: 'social_content_weekly',
        aries_run_id: run.aries_run_id,
        job_id: jobId,
        tenant_id: 'tenant-video-port',
      },
      idempotency_key: 'video-raw-submit-test',
      protocol_version: PROTOCOL_VERSION,
      provider: 'forbidden-aries-provider-selection',
    };

    await assert.rejects(
      port.submitRawRun({
        ariesRunId: run.aries_run_id,
        tenantId: 'tenant-video-port',
        workflowKey: 'social_content_weekly',
        stage: 'production',
        payload,
        callbackToken: 'a'.repeat(64),
      }),
      /Hermes owns execution selection/i,
    );
    assert.equal(calls.length, 0);
  });
});

test('live raw submit rejects unsafe video brief source URLs before Hermes fetch', async () => {
  await withDataRoot(async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const port = createPort(calls);
    const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174013';
    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'run',
      tenantId: 'tenant-video-port',
      marketingJobId: jobId,
      stage: 'production',
    });
    const payload = {
      input: 'Request (JSON): {"input":{"media_requests":[{"type":"video.generate","count":1}]}}',
      workflow_key: 'social_content_weekly',
      action: 'run',
      aries_run_id: run.aries_run_id,
      job_id: jobId,
      tenant_id: 'tenant-video-port',
      callback_url: 'https://aries.example.com/api/internal/hermes/runs',
      callback_auth: {
        type: 'internal_api_secret_bearer',
        secret_ref: 'INTERNAL_API_SECRET',
        callback_token: 'a'.repeat(64),
      },
      callback_context: {
        workflow_key: 'social_content_weekly',
        aries_run_id: run.aries_run_id,
        job_id: jobId,
        tenant_id: 'tenant-video-port',
      },
      idempotency_key: 'video-raw-source-validation-test',
      protocol_version: PROTOCOL_VERSION,
      video_brief: {
        prompt: 'Create a six-second teaser.',
        aspect_ratio: '9:16',
        duration_seconds: 6,
        input_assets: [{ type: 'https_url', url: 'https://2130706433./source.png' }],
      },
    };

    await assert.rejects(
      port.submitRawRun({
        ariesRunId: run.aries_run_id,
        tenantId: 'tenant-video-port',
        workflowKey: 'social_content_weekly',
        stage: 'production',
        payload,
        callbackToken: 'a'.repeat(64),
      }),
      /public HTTPS URL/i,
    );
    assert.equal(calls.length, 0);
  });
});

test('production resume loads the durable document and rejects non-production required-video jobs before fetch', async () => {
  await withDataRoot(async () => {
    const previousVideoPublishEnabled = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    try {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const port = createPort(calls);
      const jobId = 'job_resume_video_bypass';
      const doc = videoDoc(jobId);
      saveSocialContentJobRuntime(jobId, doc);

      await assert.rejects(
        port.resumePipeline({
          resumeToken: 'resume-video-token',
          approve: true,
          tenantId: doc.tenant_id,
          jobId,
          stage: 'production',
          workflowStepId: 'approve_video_script',
          approvalStep: 'approve_video_script',
          workflowKey: 'social_content_weekly',
        }),
        /production mkt_<uuid>/i,
      );
      assert.equal(calls.length, 0, 'invalid production resume must not reach Hermes');
    } finally {
      if (previousVideoPublishEnabled === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
      else process.env.ARIES_VIDEO_PUBLISH_ENABLED = previousVideoPublishEnabled;
    }
  });
});

test('production resume with emitted video_generate intent reaches Hermes for a valid production job', async () => {
  await withDataRoot(async () => {
    const previousVideoPublishEnabled = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    try {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const port = createPort(calls);
      const jobId = 'mkt_123e4567-e89b-42d3-a456-426614174011';
      const doc = videoDoc(jobId);
      saveSocialContentJobRuntime(jobId, doc);

      const result = await port.resumePipeline({
        resumeToken: 'resume-valid-video-token',
        approve: true,
        tenantId: doc.tenant_id,
        jobId,
        stage: 'production',
        workflowStepId: 'approve_video_script',
        approvalStep: 'approve_video_script',
        workflowKey: 'social_content_weekly',
      });

      assert.equal(result.kind, 'submitted');
      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0].init.body)) as { input?: string };
      assert.match(payload.input ?? '', /video_generate/);
      assert.doesNotMatch(payload.input ?? '', /video\.generate/);
    } finally {
      if (previousVideoPublishEnabled === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
      else process.env.ARIES_VIDEO_PUBLISH_ENABLED = previousVideoPublishEnabled;
    }
  });
});

test('production resume keeps the flag-off video request on the image-only fallback path', async () => {
  await withDataRoot(async () => {
    const previousVideoPublishEnabled = process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    try {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const port = createPort(calls);
      const jobId = 'job_flag_off_video_fallback';
      const doc = videoDoc(jobId);
      doc.stages.strategy.primary_output = {
        summary: 'The prior stage discussed video_generate without requesting a render.',
        historical_media_requests: [{ type: 'video.generate' }],
      };
      saveSocialContentJobRuntime(jobId, doc);

      const result = await port.resumePipeline({
        resumeToken: 'resume-flag-off-video-token',
        approve: true,
        tenantId: doc.tenant_id,
        jobId,
        stage: 'production',
        workflowStepId: 'approve_video_script',
        approvalStep: 'approve_video_script',
        workflowKey: 'social_content_weekly',
      });

      assert.equal(result.kind, 'submitted');
      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0].init.body)) as { input?: string };
      assert.doesNotMatch(payload.input ?? '', /^Video context \(/m);
    } finally {
      if (previousVideoPublishEnabled === undefined) delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
      else process.env.ARIES_VIDEO_PUBLISH_ENABLED = previousVideoPublishEnabled;
    }
  });
});
