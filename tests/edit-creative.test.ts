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
  createSocialContentJobRuntimeDocument,
  saveSocialContentJobRuntime,
  type MarketingBrandKitReference,
} from '../backend/marketing/runtime-state';
import {
  editCreativeAsImageEdit,
  resolveRuntimeSourceImageBasename,
} from '../backend/marketing/regenerate-creative';
import { buildSocialContentWeeklyRequest } from '../backend/social-content/workflow-request';
import { handleEditCreative } from '../app/api/social-content/jobs/[jobId]/creatives/[creativeId]/edit/handler';

const BRAND_URL = 'https://brand.edit.example/';

function buildBrandKit(): MarketingBrandKitReference {
  return {
    path: '/tmp/brand-kit-edit-test.json',
    source_url: BRAND_URL,
    canonical_url: BRAND_URL,
    brand_name: 'Edit Test Brand',
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
    style_vibe: 'Quiet Luxury',
  };
}

function buildSeedDoc(jobId: string, tenantId: string, sourceRunId: string) {
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: BRAND_URL,
      websiteUrl: BRAND_URL,
      businessType: 'Test vertical',
      businessName: 'Edit Test Brand',
    },
    brandKit: buildBrandKit(),
    createdBy: 'user_edit_seed',
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
  constructor(private readonly idPrefix: string = 'arun_edit_test') {}

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
    throw new Error('resumePipeline should not be called for edit flow');
  }

  async submitNextStage(
    _input: import('../backend/marketing/execution-port').MarketingPipelineNextStageInput,
  ): Promise<MarketingExecutionResult> {
    return { kind: 'submitted', provider: 'hermes', ariesRunId: 'arun_stub_next_stage' };
  }

  getCallbackUrl() {
    return 'https://aries.example.com/api/internal/hermes/runs';
  }
  getSessionKey() {
    return 'marketing';
  }
  async submitRawRun(): Promise<import('../backend/marketing/execution-port').SubmitRawRunResult> {
    throw new Error('submitRawRun should not be called in edit flow');
  }
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-edit-test-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

// A resolver that always returns a known basename, so we can assert it flows
// into the regenerate context without touching a DB.
const stubResolver = async () => 'gen_image_abc123.png';

test('editCreativeAsImageEdit is invisible when the flag is OFF (disabled, no run)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_off_1';
    const tenantId = 'tenant_edit_off';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_off_source');
    saveSocialContentJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'creative_off',
      tenantId,
      editInstruction: 'make the background darker',
      sourceRunId: 'arun_off_source',
      enabled: false,
      resolveSourceImage: stubResolver,
      port,
    });

    assert.equal(result.kind, 'disabled');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('editCreativeAsImageEdit submits a NEW run carrying edit_instruction + source basename', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_on_1';
    const tenantId = 'tenant_edit_on';
    const sourceRunId = 'arun_edit_source';
    const creativeId = 'img_3';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId,
      tenantId,
      editInstruction: '  make the background darker  ',
      sourceRunId,
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });

    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.sourceRunId, sourceRunId);
    assert.equal(result.sourceCreativeId, creativeId);
    assert.equal(result.editInstruction, 'make the background darker'); // trimmed
    assert.equal(result.sourceImageBasename, 'gen_image_abc123.png');
    assert.notEqual(result.ariesRunId, sourceRunId);

    assert.equal(port.capturedRuns.length, 1);
    assert.deepEqual(port.capturedRuns[0].regenerateCreative, {
      source_run_id: sourceRunId,
      source_creative_id: creativeId,
      edit_instruction: 'make the background darker',
      source_image_basename: 'gen_image_abc123.png',
    });
  });
});

test('editCreativeAsImageEdit still submits when the source image is unresolvable (basename omitted)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_on_2';
    const tenantId = 'tenant_edit_on';
    const sourceRunId = 'arun_edit_source_2';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_unresolvable',
      tenantId,
      editInstruction: 'add a warmer tone',
      sourceRunId,
      enabled: true,
      resolveSourceImage: async () => null, // ingested/unresolvable
      port,
    });

    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.sourceImageBasename, null);
    assert.equal(port.capturedRuns.length, 1);
    // No source_image_basename key when unresolvable; Hermes falls back to ids.
    assert.deepEqual(port.capturedRuns[0].regenerateCreative, {
      source_run_id: sourceRunId,
      source_creative_id: 'img_unresolvable',
      edit_instruction: 'add a warmer tone',
    });
  });
});

test('editCreativeAsImageEdit rejects an empty instruction (missing_edit_instruction)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_on_3';
    const tenantId = 'tenant_edit_on';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_edit_source_3');
    saveSocialContentJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: '   ',
      sourceRunId: 'arun_edit_source_3',
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });

    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.equal(result.code, 'missing_edit_instruction');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('editCreativeAsImageEdit rejects cross-tenant access (tenant_mismatch, no run)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_on_4';
    const ownerTenantId = 'tenant_edit_owner';
    const attackerTenantId = 'tenant_edit_attacker';
    const doc = buildSeedDoc(jobId, ownerTenantId, 'arun_owner_source');
    saveSocialContentJobRuntime(jobId, doc);

    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId: attackerTenantId,
      editInstruction: 'make it brighter',
      sourceRunId: 'arun_owner_source',
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });

    assert.equal(result.kind, 'tenant_mismatch');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('buildSocialContentWeeklyRequest serializes edit fields into the request input', async () => {
  await withDataRoot(async () => {
    const doc = buildSeedDoc('mkt_edit_req_1', 'tenant_edit_req', 'arun_req_source');
    const request = buildSocialContentWeeklyRequest({
      doc,
      ariesRunId: 'arun_req_new',
      callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
      regenerateCreative: {
        source_run_id: 'arun_req_source',
        source_creative_id: 'img_2',
        edit_instruction: 'remove the corner text',
        source_image_basename: 'gen_xyz.png',
      },
    });

    assert.deepEqual(request.input.regenerate_creative, {
      source_run_id: 'arun_req_source',
      source_creative_id: 'img_2',
      edit_instruction: 'remove the corner text',
      source_image_basename: 'gen_xyz.png',
    });
  });
});

test('POST /edit returns 404 when the flag is OFF (invisible endpoint)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_route_off';
    const tenantId = 'tenant_edit_route';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_route_source');
    saveSocialContentJobRuntime(jobId, doc);

    // Flag unset → default OFF → disabled → 404, BEFORE any auth/DB. The route
    // must be invisible: the tenant loader is never invoked, no port call.
    const previous = process.env.ARIES_IMAGE_EDIT_ENABLED;
    delete process.env.ARIES_IMAGE_EDIT_ENABLED;
    const port = new StubMarketingPort();
    let loaderCalls = 0;
    try {
      const response = await handleEditCreative(
        jobId,
        'img_1',
        new Request('http://aries.example.test/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instruction: 'make it brighter' }),
        }),
        async () => {
          loaderCalls += 1;
          return {
            userId: 'user_edit_route',
            tenantId,
            tenantSlug: 'tenant-edit-route',
            role: 'tenant_admin',
          };
        },
        { port },
      );

      assert.equal(response.status, 404);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.reason, 'social_content_job_not_found');
      assert.equal(port.capturedRuns.length, 0);
      assert.equal(loaderCalls, 0, 'tenant loader must not run when the flag is OFF');
    } finally {
      if (previous === undefined) delete process.env.ARIES_IMAGE_EDIT_ENABLED;
      else process.env.ARIES_IMAGE_EDIT_ENABLED = previous;
    }
  });
});

test('resolveRuntimeSourceImageBasename returns the basename with tenant/job-scoped params', async () => {
  const calls: unknown[][] = [];
  const db = {
    query: async (_sql: string, params?: unknown[]) => {
      if (params) calls.push(params);
      return { rows: [{ storage_key: '/hermes-media/gen_a.png' }] };
    },
  };
  const basename = await resolveRuntimeSourceImageBasename(
    { tenantId: '15', jobId: 'job_1', creativeId: 'cre_1' },
    db,
  );
  assert.equal(basename, 'gen_a.png');
  // params are [tenantIdInt, creativeId, jobId] — tenant is coerced to int and
  // the query is scoped to BOTH tenant and job.
  assert.deepEqual(calls[0], [15, 'cre_1', 'job_1']);
});

test('resolveRuntimeSourceImageBasename rejects unsafe basenames, bad tenants, empty rows, and fails open', async () => {
  const rowsFor = (key: string) => ({ query: async () => ({ rows: [{ storage_key: key }] }) });
  // Unsafe basenames (path.basename still containing .. or a backslash) are rejected.
  assert.equal(await resolveRuntimeSourceImageBasename({ tenantId: '1', jobId: 'j', creativeId: 'c' }, rowsFor('..')), null);
  assert.equal(await resolveRuntimeSourceImageBasename({ tenantId: '1', jobId: 'j', creativeId: 'c' }, rowsFor('a\\b.png')), null);
  // No matching runtime_asset row → null.
  assert.equal(
    await resolveRuntimeSourceImageBasename({ tenantId: '1', jobId: 'j', creativeId: 'c' }, { query: async () => ({ rows: [] }) }),
    null,
  );
  // Non-positive / NaN tenant short-circuits BEFORE any query.
  let queried = false;
  const spyDb = {
    query: async () => {
      queried = true;
      return { rows: [{ storage_key: '/x/a.png' }] };
    },
  };
  assert.equal(await resolveRuntimeSourceImageBasename({ tenantId: '0', jobId: 'j', creativeId: 'c' }, spyDb), null);
  assert.equal(await resolveRuntimeSourceImageBasename({ tenantId: 'abc', jobId: 'j', creativeId: 'c' }, spyDb), null);
  assert.equal(queried, false, 'must not query with a non-positive / NaN tenant');
  // A DB error fails open to null (the edit still submits via id-based fallback).
  assert.equal(
    await resolveRuntimeSourceImageBasename(
      { tenantId: '1', jobId: 'j', creativeId: 'c' },
      { query: async () => { throw new Error('db down'); } },
    ),
    null,
  );
});

test('editCreativeAsImageEdit returns job_not_found for an unknown job (no run)', async () => {
  await withDataRoot(async () => {
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId: 'mkt_edit_missing',
      creativeId: 'img_1',
      tenantId: 'tenant_x',
      editInstruction: 'make it brighter',
      sourceRunId: 'arun_x',
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });
    assert.equal(result.kind, 'job_not_found');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('editCreativeAsImageEdit rejects an empty creativeId (missing_creative_id, no run)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_empty_cre';
    const tenantId = 'tenant_edit_on';
    const doc = buildSeedDoc(jobId, tenantId, 'arun_src_empty_cre');
    saveSocialContentJobRuntime(jobId, doc);
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: '   ',
      tenantId,
      editInstruction: 'make it brighter',
      sourceRunId: 'arun_src_empty_cre',
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });
    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.equal(result.code, 'missing_creative_id');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('editCreativeAsImageEdit requires a resolvable source_run_id (no inferrable stage run)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_no_run';
    const tenantId = 'tenant_edit_on';
    // A fresh doc with NO stage run_ids stamped — inferSourceRunIdFromDoc yields ''.
    const doc = createSocialContentJobRuntimeDocument({
      jobId,
      tenantId,
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: BRAND_URL,
        websiteUrl: BRAND_URL,
        businessType: 'Test vertical',
        businessName: 'Edit Test Brand',
      },
      brandKit: buildBrandKit(),
      createdBy: 'user_no_run',
    });
    saveSocialContentJobRuntime(jobId, doc);
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: 'make it brighter',
      sourceRunId: undefined,
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });
    assert.equal(result.kind, 'invalid_input');
    if (result.kind !== 'invalid_input') return;
    assert.equal(result.code, 'missing_source_run_id');
    assert.equal(port.capturedRuns.length, 0);
  });
});

test('editCreativeAsImageEdit ignores an explicit source_run_id that is not part of the job', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_foreign_run';
    const tenantId = 'tenant_edit_on';
    const realRunId = 'arun_real_for_job';
    const doc = buildSeedDoc(jobId, tenantId, realRunId);
    saveSocialContentJobRuntime(jobId, doc);
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: 'make it brighter',
      // A run id the operator supplied that does NOT belong to this job's stages.
      sourceRunId: 'arun_FOREIGN_not_in_doc',
      enabled: true,
      resolveSourceImage: async () => null,
      port,
    });
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    // Falls back to the inferred in-job run id, NOT the untrusted body value.
    assert.equal(result.sourceRunId, realRunId);
    assert.equal(port.capturedRuns[0].regenerateCreative?.source_run_id, realRunId);
  });
});

test('editCreativeAsImageEdit caps the instruction at 2000 characters', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_cap';
    const tenantId = 'tenant_edit_on';
    const sourceRunId = 'arun_cap_src';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: 'a'.repeat(2500),
      sourceRunId,
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.editInstruction.length, 2000);
    assert.equal(
      (port.capturedRuns[0].regenerateCreative?.edit_instruction ?? '').length,
      2000,
    );
  });
});

test('editCreativeAsImageEdit fails open when the source resolver THROWS (still submits, basename omitted)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_resolver_throw';
    const tenantId = 'tenant_edit_on';
    const sourceRunId = 'arun_throw_src';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);
    const port = new StubMarketingPort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: 'add a warmer tone',
      sourceRunId,
      enabled: true,
      resolveSourceImage: async () => {
        throw new Error('resolver boom');
      },
      port,
    });
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') return;
    assert.equal(result.sourceImageBasename, null);
    assert.deepEqual(port.capturedRuns[0].regenerateCreative, {
      source_run_id: sourceRunId,
      source_creative_id: 'img_1',
      edit_instruction: 'add a warmer tone',
    });
  });
});

test('editCreativeAsImageEdit detects an aries_run_id collision (edit_run_collision)', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_collision';
    const tenantId = 'tenant_edit_on';
    const sourceRunId = 'arun_collide_src';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);

    class CollidePort extends StubMarketingPort {
      async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
        this.capturedRuns.push(input);
        return { kind: 'submitted', provider: 'hermes', ariesRunId: sourceRunId, hermesRunId: 'h' };
      }
    }

    const port = new CollidePort();
    const result = await editCreativeAsImageEdit({
      jobId,
      creativeId: 'img_1',
      tenantId,
      editInstruction: 'make it brighter',
      sourceRunId,
      enabled: true,
      resolveSourceImage: stubResolver,
      port,
    });
    assert.equal(result.kind, 'failed');
    if (result.kind !== 'failed') return;
    assert.equal(result.code, 'edit_run_collision');
  });
});

test('POST /edit returns 400 for a missing instruction when the flag is ON', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_route_400';
    const tenantId = 'tenant_edit_route_400';
    const sourceRunId = 'arun_route_400_src';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);

    const previous = process.env.ARIES_IMAGE_EDIT_ENABLED;
    process.env.ARIES_IMAGE_EDIT_ENABLED = '1';
    const port = new StubMarketingPort();
    try {
      const response = await handleEditCreative(
        jobId,
        'img_1',
        new Request('http://aries.example.test/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instruction: '   ', source_run_id: sourceRunId }),
        }),
        async () => ({
          userId: 'user_edit_route_400',
          tenantId,
          tenantSlug: 'tenant-edit-route-400',
          role: 'tenant_admin',
        }),
        { port },
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.reason, 'missing_edit_instruction');
      assert.equal(port.capturedRuns.length, 0);
    } finally {
      if (previous === undefined) delete process.env.ARIES_IMAGE_EDIT_ENABLED;
      else process.env.ARIES_IMAGE_EDIT_ENABLED = previous;
    }
  });
});

test('POST /edit returns 202 with new_run_id when the flag is ON', async () => {
  await withDataRoot(async () => {
    const jobId = 'mkt_edit_route_on';
    const tenantId = 'tenant_edit_route_on';
    const sourceRunId = 'arun_route_on_source';
    const doc = buildSeedDoc(jobId, tenantId, sourceRunId);
    saveSocialContentJobRuntime(jobId, doc);

    const previous = process.env.ARIES_IMAGE_EDIT_ENABLED;
    process.env.ARIES_IMAGE_EDIT_ENABLED = '1';
    const port = new StubMarketingPort('arun_edit_route');
    try {
      const response = await handleEditCreative(
        jobId,
        'img_5',
        new Request('http://aries.example.test/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instruction: 'make the background darker', source_run_id: sourceRunId }),
        }),
        async () => ({
          userId: 'user_edit_route_on',
          tenantId,
          tenantSlug: 'tenant-edit-route-on',
          role: 'tenant_admin',
        }),
        { port },
      );

      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.status, 'submitted');
      assert.equal(body.edited, true);
      assert.equal(body.source_creative_id, 'img_5');
      assert.equal(typeof body.new_run_id, 'string');
      assert.notEqual(body.new_run_id, sourceRunId);
      assert.equal(port.capturedRuns.length, 1);
      // The route's default resolver fail-opens to null without a DB; the edit
      // instruction must still ride the regenerate context.
      assert.equal(port.capturedRuns[0].regenerateCreative?.edit_instruction, 'make the background darker');
    } finally {
      if (previous === undefined) delete process.env.ARIES_IMAGE_EDIT_ENABLED;
      else process.env.ARIES_IMAGE_EDIT_ENABLED = previous;
    }
  });
});
