import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Guards the retry-research recovery path. Tests run the handler directly,
// bypassing Next.js routing, with a stubbed tenant context loader and a
// DATA_ROOT pointed at a tmpdir so the runtime doc on disk is the only state
// these tests touch. The orchestrator's retryFailedResearchStage runs against
// that same on-disk doc, but its actual Hermes submission is short-circuited
// by an injected execution-port stub (see __setMarketingExecutionPortForTests).

const ORIGINAL_DATA_ROOT = process.env.DATA_ROOT;
const TEST_ROOT = path.join(
  tmpdir(),
  `aries-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function nowIso() {
  return new Date().toISOString();
}

async function writeFailedResearchDoc(jobId: string, overrides: Record<string, unknown> = {}) {
  const base = {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    job_type: 'one_off_campaign',
    tenant_id: 'tenant_acme',
    state: 'failed',
    status: 'failed',
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: {
        stage: 'research',
        status: 'failed',
        started_at: nowIso(),
        completed_at: null,
        failed_at: nowIso(),
        run_id: 'r1',
        summary: null,
        primary_output: { something: 'partial' },
        outputs: { partial: true },
        artifacts: [{ id: 'a1' }],
        errors: [{ code: 'upstream', message: 'NoneType', stage: 'research', retryable: true, at: nowIso() }],
      },
      strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://aries.example.com',
      canonical_url: 'https://aries.example.com',
      brand_name: 'Example',
      logo_urls: [],
      colors: { primary: '#000', secondary: '#111', accent: '#222', palette: ['#000'] },
      font_families: ['Inter'],
      external_links: [],
      extracted_at: nowIso(),
    },
    inputs: { request: { jobType: 'one_off_campaign' }, brand_url: 'https://aries.example.com' },
    errors: [{ code: 'upstream', message: 'NoneType', stage: 'research', retryable: true, at: nowIso() }],
    last_error: { code: 'upstream', message: 'NoneType', stage: 'research', retryable: true, at: nowIso() },
    history: [],
    created_at: nowIso(),
    updated_at: nowIso(),
    created_by: null,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
  const filePath = path.join(TEST_ROOT, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(base, null, 2));
  return filePath;
}

// --- resetStageForRetry helper -----------------------------------------------
//
// The lowest layer of the retry path. These tests pin the exact reset shape so
// the orchestrator never re-enters runResearchStage against a stale `failed`
// record. Validates the resumability rule: sibling completed stages keep
// their artifacts; only the failed stage's record + top-level error pointers
// are cleared.

describe('resetStageForRetry', () => {
  before(() => { process.env.DATA_ROOT = TEST_ROOT; });
  after(async () => {
    if (ORIGINAL_DATA_ROOT === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = ORIGINAL_DATA_ROOT;
    if (existsSync(TEST_ROOT)) await rm(TEST_ROOT, { recursive: true, force: true });
  });
  beforeEach(async () => {
    if (existsSync(TEST_ROOT)) await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('resets a failed stage record back to not_started and clears its errors', async () => {
    const { resetStageForRetry } = await import('../backend/marketing/runtime-state');
    await writeFailedResearchDoc('job_reset_basic');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await loadMarketingJobRuntime('job_reset_basic');
    assert.ok(doc);

    const ok = resetStageForRetry(doc, 'research');
    assert.equal(ok, true);

    const record = doc.stages.research;
    assert.equal(record.status, 'not_started');
    assert.equal(record.failed_at, null);
    assert.equal(record.run_id, null);
    assert.deepEqual(record.errors, []);
    assert.deepEqual(record.outputs, {});
    assert.deepEqual(record.artifacts, []);

    assert.equal(doc.state, 'queued');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.current_stage, 'research');
    assert.equal(doc.last_error, null);
    assert.deepEqual(doc.errors.filter((e) => e.stage === 'research'), []);
    // History gains a retry-requested entry — proves the operator action was recorded.
    assert.ok(doc.history.some((h) => /retry requested/i.test(h.note)));
  });

  it('returns false (no-op) when the stage is not in a failed state', async () => {
    const { resetStageForRetry } = await import('../backend/marketing/runtime-state');
    await writeFailedResearchDoc('job_reset_noop', {
      stages: {
        research: { stage: 'research', status: 'completed', started_at: nowIso(), completed_at: nowIso(), failed_at: null, run_id: 'r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
    });
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await loadMarketingJobRuntime('job_reset_noop');
    assert.ok(doc);

    const ok = resetStageForRetry(doc, 'research');
    assert.equal(ok, false, 'must NOT reset a completed stage');
    assert.equal(doc.stages.research.status, 'completed');
  });

  it('preserves sibling completed-stage artifacts (resumability rule)', async () => {
    const { resetStageForRetry } = await import('../backend/marketing/runtime-state');
    await writeFailedResearchDoc('job_reset_siblings', {
      stages: {
        research: { stage: 'research', status: 'failed', started_at: nowIso(), completed_at: null, failed_at: nowIso(), run_id: 'r', summary: null, primary_output: null, outputs: { foo: 1 }, artifacts: [], errors: [{ code: 'x', message: 'y', stage: 'research', retryable: true, at: nowIso() }] },
        strategy: { stage: 'strategy', status: 'completed', started_at: nowIso(), completed_at: nowIso(), failed_at: null, run_id: 's', summary: null, primary_output: { kept: true }, outputs: { keepme: true }, artifacts: [{ id: 'a1' }], errors: [] },
        production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
    });
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await loadMarketingJobRuntime('job_reset_siblings');
    assert.ok(doc);

    resetStageForRetry(doc, 'research');
    // Strategy stage MUST be untouched.
    assert.equal(doc.stages.strategy.status, 'completed');
    assert.deepEqual(doc.stages.strategy.primary_output, { kept: true });
    assert.deepEqual(doc.stages.strategy.artifacts, [{ id: 'a1' }]);
  });
});

// --- Handler permission + state-gate tests ----------------------------------
//
// Exercises the HTTP layer: tenant scoping, role check, 404 on missing,
// 404 on cross-tenant (existence leak guard), 409 on wrong-state. The actual
// orchestrator submission is stubbed so we don't hit Hermes.

describe('POST /api/marketing/jobs/:jobId/retry-research', () => {
  before(() => { process.env.DATA_ROOT = TEST_ROOT; });
  after(async () => {
    if (ORIGINAL_DATA_ROOT === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = ORIGINAL_DATA_ROOT;
    if (existsSync(TEST_ROOT)) await rm(TEST_ROOT, { recursive: true, force: true });
  });
  beforeEach(async () => {
    if (existsSync(TEST_ROOT)) await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns 404 when the job does not exist', async () => {
    const { handleRetryResearchStage } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );
    const response = await handleRetryResearchStage('does_not_exist', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(response.status, 404);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'marketing_job_not_found');
  });

  it('returns 404 (not 403) when the job belongs to a different tenant — no existence leak', async () => {
    const { handleRetryResearchStage } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );
    await writeFailedResearchDoc('job_other_tenant', { tenant_id: 'tenant_other' });
    const response = await handleRetryResearchStage('job_other_tenant', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(response.status, 404);
  });

  it('returns 403 when caller is non-admin and not the creator', async () => {
    const { handleRetryResearchStage } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );
    await writeFailedResearchDoc('job_other_owner', { created_by: 'user_other' });
    const response = await handleRetryResearchStage('job_other_owner', async () => ({
      userId: 'user_analyst',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_analyst',
    }));
    assert.equal(response.status, 403);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'marketing_job_retry_forbidden');
  });

  it('returns 409 when the job is not in a failed state', async () => {
    const { handleRetryResearchStage } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );
    await writeFailedResearchDoc('job_not_failed', { state: 'running', status: 'running' });
    const response = await handleRetryResearchStage('job_not_failed', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(response.status, 409);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'marketing_job_retry_not_failed');
  });

  it('returns 409 with wrong_stage reason when the failure was on a non-research stage', async () => {
    const { handleRetryResearchStage } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );
    await writeFailedResearchDoc('job_wrong_stage', { current_stage: 'strategy' });
    const response = await handleRetryResearchStage('job_wrong_stage', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(response.status, 409);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'marketing_job_retry_wrong_stage');
  });
});

// --- Permission helper isolation test --------------------------------------

describe('evaluateRetryPermission', () => {
  it('grants access to tenant_admin, to the creator, and denies others', async () => {
    const { __evaluateRetryPermissionForTests: evalFn } = await import(
      '../app/api/marketing/jobs/[jobId]/retry-research/handler'
    );

    assert.equal(
      evalFn({ tenantId: 'a', role: 'tenant_admin', userId: 'u', docTenantId: 'a', docCreatedBy: 'other' }).allowed,
      true,
    );
    assert.equal(
      evalFn({ tenantId: 'a', role: 'tenant_analyst', userId: 'creator', docTenantId: 'a', docCreatedBy: 'creator' }).allowed,
      true,
    );
    const denied = evalFn({ tenantId: 'a', role: 'tenant_analyst', userId: 'u', docTenantId: 'a', docCreatedBy: 'other' });
    assert.equal(denied.allowed, false);
    if (denied.allowed === false) assert.equal(denied.reason, 'forbidden');

    const crossTenant = evalFn({ tenantId: 'a', role: 'tenant_admin', userId: 'u', docTenantId: 'b', docCreatedBy: 'u' });
    assert.equal(crossTenant.allowed, false);
    if (crossTenant.allowed === false) assert.equal(crossTenant.reason, 'not_found');

    // Pre-created_by campaigns (null creator) are admin-only.
    const legacyNonAdmin = evalFn({ tenantId: 'a', role: 'tenant_analyst', userId: 'u', docTenantId: 'a', docCreatedBy: null });
    assert.equal(legacyNonAdmin.allowed, false);
  });
});
