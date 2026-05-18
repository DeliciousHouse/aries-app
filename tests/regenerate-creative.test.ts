import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  MarketingExecutionPort,
  MarketingExecutionResult,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../backend/marketing/execution-port';
import {
  createMarketingJobRuntimeDocument,
  loadMarketingJobRuntime,
  saveMarketingJobRuntime,
  type MarketingBrandKitReference,
} from '../backend/marketing/runtime-state';
import { regenerateCreativeAsNewRun } from '../backend/marketing/regenerate-creative';
import { handleRegenerateCreative } from '../app/api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate/handler';

const BRAND_URL = 'https://brand.regenerate.example/';

function buildBrandKit(): MarketingBrandKitReference {
  return {
    path: '/tmp/brand-kit-regen-test.json',
    source_url: BRAND_URL,
    canonical_url: BRAND_URL,
    brand_name: 'Regenerate Test Brand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: null,
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  };
}

function buildSeedDoc(jobId: string, tenantId: string, sourceRunId: string) {
  const doc = createMarketingJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: BRAND_URL,
      websiteUrl: BRAND_URL,
      businessType: 'Test vertical',
      businessName: 'Regenerate Test Brand',
    },
    brandKit: buildBrandKit(),
    createdBy: 'user_regen_seed',
  });
  doc.stages.research.run_id = sourceRunId;
  doc.stages.research.status = 'completed';
  doc.stages.production.run_id = sourceRunId;
  return doc;
}

class StubMarketingPort implements MarketingExecutionPort {
  readonly name = 'hermes' as const;
  public capturedRuns: MarketingPipelineRunInput[] = [];
  private runCounter = 0;
  constructor(private readonly idPrefix: string = 'arun_regen_test') {}

  async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
    this.capturedRuns.push(input);
    this.runCounter += 1;
    return {
      kind: 'submitted',
      provider: 'hermes',
      ariesRunId: `${this.idPrefix}_${this.runCounter}_${Date.now()}`,
      hermesRunId: `hermes_run_${this.runCounter}`,
    };
  }

  async resumePipeline(_input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult> {
    throw new Error('resumePipeline should not be called for regenerate flow');
  }

  async submitNextStage(_input: import('../backend/marketing/execution-port').MarketingPipelineNextStageInput): Promise<MarketingExecutionResult> {
    return { kind: 'submitted', provider: 'hermes', ariesRunId: 'arun_stub_next_stage' };
  }

  getCallbackUrl() { return 'https://aries.example.com/api/internal/hermes/runs'; }
  getSessionKey() { return 'marketing'; }
  async submitRawRun(): Promise<import('../backend/marketing/execution-port').SubmitRawRunResult> {
    throw new Error('submitRawRun should not be called in regenerate flow');
  }
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-regen-test-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('regenerateCreativeAsNewRun submits a NEW aries_run with regenerate context', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_helper_1';
    const tenantId = 'tenant_regen_helper';
    const sourceRunId = 'arun_source_helper_run';
    const creativeId = 'creative_helper_42';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId,
      tenantId,
      sourceRunId,
      port,
    });

    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.sourceRunId, sourceRunId);
    assert.equal(result.sourceCreativeId, creativeId);
    assert.equal(result.jobId, jobId);
    assert.equal(result.tenantId, tenantId);
    assert.notEqual(result.ariesRunId, sourceRunId);
    assert.match(result.ariesRunId, /^arun_regen_test_/);
    assert.equal(port.capturedRuns.length, 1);
    assert.deepEqual(port.capturedRuns[0].regenerateCreative, {
      source_run_id: sourceRunId,
      source_creative_id: creativeId,
    });
    assert.equal(port.capturedRuns[0].jobId, jobId);
    assert.equal(port.capturedRuns[0].doc.tenant_id, tenantId);
  });
});

test('regenerateCreativeAsNewRun infers source_run_id from runtime doc when omitted', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_helper_2';
    const tenantId = 'tenant_regen_helper';
    const inferredRunId = 'arun_inferred_research';
    const doc = buildSeedDoc(jobId, tenantId, inferredRunId);
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId: 'creative_inferred',
      tenantId,
      port,
    });

    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.sourceRunId, inferredRunId);
    assert.notEqual(result.ariesRunId, inferredRunId);
  });
});

test('regenerateCreativeAsNewRun rejects cross-tenant access (job_not_found contract)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_helper_3';
    const ownerTenantId = 'tenant_owner_helper';
    const attackerTenantId = 'tenant_attacker_helper';
    const sourceRunId = 'arun_owner_source';
    const doc = buildSeedDoc(jobId, ownerTenantId, sourceRunId);
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId: 'creative_attacker',
      tenantId: attackerTenantId,
      sourceRunId,
      port,
    });

    assert.equal(result.kind, 'tenant_mismatch');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('regenerateCreativeAsNewRun returns invalid_input when creativeId is empty', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_helper_4';
    const tenantId = 'tenant_regen_helper';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_with_run');
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId: '   ',
      tenantId,
      sourceRunId: 'arun_with_run',
      port,
    });

    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.equal(result.code, 'missing_creative_id');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('regenerateCreativeAsNewRun returns missing_source_run_id when doc has no run', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_helper_5';
    const tenantId = 'tenant_regen_helper';
    const doc = createMarketingJobRuntimeDocument({
      jobId,
      tenantId,
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: BRAND_URL,
        websiteUrl: BRAND_URL,
        businessType: 'Test vertical',
        businessName: 'Regenerate Test Brand',
      },
      brandKit: buildBrandKit(),
    });
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId: 'creative_no_run',
      tenantId,
      port,
    });

    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.equal(result.code, 'missing_source_run_id');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('POST /regenerate route returns 202 with new_run_id !== source_run_id', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_route_1';
    const tenantId = 'tenant_regen_route';
    const sourceRunId = 'arun_route_source_run';
    const creativeId = 'creative_route_99';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort('arun_regen_route');
    const response = await handleRegenerateCreative(
      jobId,
      creativeId,
      new Request('http://aries.example.test/api/social-content/jobs/x/creatives/y/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_run_id: sourceRunId }),
      }),
      async () => ({
        userId: 'user_regen_route',
        tenantId,
        tenantSlug: 'tenant-regen-route',
        role: 'tenant_admin',
      }),
      { port },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, 'submitted');
    assert.equal(body.jobId, jobId);
    assert.equal(body.creativeId, creativeId);
    assert.equal(body.source_run_id, sourceRunId);
    assert.equal(body.source_creative_id, creativeId);
    assert.equal(typeof body.new_run_id, 'string');
    assert.notEqual(body.new_run_id, sourceRunId);
    assert.match(String(body.new_run_id), /^arun_regen_route_/);
    assert.equal(body.hermes_run_id, 'hermes_run_1');
    assert.equal(port.capturedRuns.length, 1);
  });
});

test('POST /regenerate denies cross-tenant requests with 404', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_route_2';
    const ownerTenantId = 'tenant_route_owner';
    const attackerTenantId = 'tenant_route_attacker';
    const doc = buildSeedDoc(jobId, ownerTenantId, 'arun_route_owner_source');
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const response = await handleRegenerateCreative(
      jobId,
      'creative_route_42',
      new Request('http://aries.example.test/api/social-content/jobs/x/creatives/y/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_run_id: 'arun_route_owner_source' }),
      }),
      async () => ({
        userId: 'attacker',
        tenantId: attackerTenantId,
        tenantSlug: 'tenant-route-attacker',
        role: 'tenant_admin',
      }),
      { port },
    );

    assert.equal(response.status, 404);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.reason, 'social_content_job_not_found');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('POST /regenerate rejects unauthenticated callers with 403', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_route_3';
    const tenantId = 'tenant_route_unauth';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_route_unauth_source');
    saveMarketingJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const response = await handleRegenerateCreative(
      jobId,
      'creative_route_unauth',
      new Request('http://aries.example.test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_run_id: 'arun_route_unauth_source' }),
      }),
      async () => {
        throw new Error('Authentication required.');
      },
      { port },
    );

    assert.equal(response.status, 403);
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('regenerate preserves the source runtime doc (no deletion or in-place mutation)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_regen_route_4';
    const tenantId = 'tenant_regen_preserve';
    const sourceRunId = 'arun_preserve_source';
    const creativeId = 'creative_preserve_77';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveMarketingJobRuntime(jobId, doc);

    const docBefore = await loadMarketingJobRuntime(jobId);
    assert.ok(docBefore);
    const beforeUpdatedAt = docBefore.updated_at;
    const beforeResearchRunId = docBefore.stages.research.run_id;

    const port = new StubMarketingPort();
    const result = await regenerateCreativeAsNewRun({
      jobId,
      creativeId,
      tenantId,
      sourceRunId,
      port,
    });

    assert.equal(result.kind, 'submitted');

    const docAfter = await loadMarketingJobRuntime(jobId);
    assert.ok(docAfter);
    assert.equal(docAfter.tenant_id, tenantId);
    assert.equal(docAfter.stages.research.run_id, beforeResearchRunId);
    assert.equal(docAfter.updated_at, beforeUpdatedAt);
    assert.equal(docAfter.stages.research.status, 'completed');
  });
});
