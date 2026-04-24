import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Guard: these tests run the handler directly, bypassing Next.js routing.
// Each test builds a minimal runtime doc on disk under DATA_ROOT, exercises
// the handler with a stubbed tenant context loader, then asserts the file
// state after the call.

const ORIGINAL_DATA_ROOT = process.env.DATA_ROOT;
const TEST_ROOT = path.join(tmpdir(), `aries-delete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function writeRuntimeDoc(jobId: string, overrides: Record<string, unknown>) {
  const base = {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    job_type: 'brand_campaign',
    tenant_id: 'tenant_acme',
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 's', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'pu', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Example',
      logo_urls: [],
      colors: { primary: '#000', secondary: '#111', accent: '#222', palette: ['#000'] },
      font_families: ['Inter'],
      external_links: [],
      extracted_at: '2026-04-01T00:00:00.000Z',
    },
    inputs: { request: {}, brand_url: 'https://example.com' },
    errors: [],
    last_error: null,
    history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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

describe('DELETE /api/marketing/jobs/:jobId', () => {
  before(() => {
    process.env.DATA_ROOT = TEST_ROOT;
  });

  after(async () => {
    if (ORIGINAL_DATA_ROOT === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = ORIGINAL_DATA_ROOT;
    }
    if (existsSync(TEST_ROOT)) {
      await rm(TEST_ROOT, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    if (existsSync(TEST_ROOT)) {
      await rm(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('soft-deletes a campaign when caller is tenant_admin', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    await writeRuntimeDoc('job_admin', { tenant_id: 'tenant_acme', created_by: 'user_other' });
    const response = await handleDeleteMarketingJob('job_admin', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));

    assert.equal(response.status, 200);
    const body = (await response.json()) as { deletedAt: string | null; deletedBy: string | null };
    assert.ok(body.deletedAt);
    assert.equal(body.deletedBy, 'user_admin');

    const doc = await loadMarketingJobRuntime('job_admin');
    assert.ok(doc);
    assert.ok(doc.deleted_at);
    assert.equal(doc.deleted_by, 'user_admin');
  });

  it('soft-deletes a campaign when caller is the creator (non-admin)', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');

    await writeRuntimeDoc('job_creator', { tenant_id: 'tenant_acme', created_by: 'user_analyst' });
    const response = await handleDeleteMarketingJob('job_creator', async () => ({
      userId: 'user_analyst',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_analyst',
    }));

    assert.equal(response.status, 200);
  });

  it('returns 403 when caller is neither admin nor creator', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');

    await writeRuntimeDoc('job_forbidden', { tenant_id: 'tenant_acme', created_by: 'user_other' });
    const response = await handleDeleteMarketingJob('job_forbidden', async () => ({
      userId: 'user_analyst',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_analyst',
    }));

    assert.equal(response.status, 403);
    const body = (await response.json()) as { reason: string };
    assert.equal(body.reason, 'marketing_job_delete_forbidden');
  });

  it('returns 404 (not 403) when the job belongs to a different tenant, to avoid existence leakage', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');

    await writeRuntimeDoc('job_cross_tenant', { tenant_id: 'tenant_other', created_by: 'user_x' });
    const response = await handleDeleteMarketingJob('job_cross_tenant', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));

    assert.equal(response.status, 404);
  });

  it('treats campaigns with no created_by as admin-only for delete', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');

    await writeRuntimeDoc('job_legacy', { tenant_id: 'tenant_acme', created_by: null });

    const nonAdminResponse = await handleDeleteMarketingJob('job_legacy', async () => ({
      userId: 'user_analyst',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_analyst',
    }));
    assert.equal(nonAdminResponse.status, 403);

    const adminResponse = await handleDeleteMarketingJob('job_legacy', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(adminResponse.status, 200);
  });

  it('is idempotent on repeat delete: preserves the original deleted_at + deleted_by', async () => {
    const { handleDeleteMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    await writeRuntimeDoc('job_idempotent', { tenant_id: 'tenant_acme', created_by: null });

    const first = await handleDeleteMarketingJob('job_idempotent', async () => ({
      userId: 'user_admin_1',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { deletedAt: string | null; deletedBy: string | null };
    const originalDeletedAt = firstBody.deletedAt;
    const originalDeletedBy = firstBody.deletedBy;
    assert.ok(originalDeletedAt);
    assert.equal(originalDeletedBy, 'user_admin_1');

    // Wait long enough that a naive nowIso() overwrite would produce a
    // different timestamp, then hit DELETE again as a different user.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await handleDeleteMarketingJob('job_idempotent', async () => ({
      userId: 'user_admin_2',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { deletedAt: string | null; deletedBy: string | null };
    assert.equal(secondBody.deletedAt, originalDeletedAt, 'deleted_at must not be rewritten by a repeat delete');
    assert.equal(secondBody.deletedBy, originalDeletedBy, 'deleted_by must not be rewritten by a repeat delete');

    const doc = await loadMarketingJobRuntime('job_idempotent');
    assert.ok(doc);
    assert.equal(doc.deleted_at, originalDeletedAt);
    assert.equal(doc.deleted_by, originalDeletedBy);
  });
});

describe('POST /api/marketing/jobs/:jobId/restore', () => {
  before(() => {
    process.env.DATA_ROOT = TEST_ROOT;
  });

  after(async () => {
    if (ORIGINAL_DATA_ROOT === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = ORIGINAL_DATA_ROOT;
    }
    if (existsSync(TEST_ROOT)) {
      await rm(TEST_ROOT, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    if (existsSync(TEST_ROOT)) {
      await rm(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('clears deleted_at when the caller has permission', async () => {
    const { handleRestoreMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    await writeRuntimeDoc('job_restore', {
      tenant_id: 'tenant_acme',
      created_by: 'user_admin',
      deleted_at: '2026-04-16T00:00:00.000Z',
      deleted_by: 'user_admin',
    });

    const response = await handleRestoreMarketingJob('job_restore', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));

    assert.equal(response.status, 200);
    const doc = await loadMarketingJobRuntime('job_restore');
    assert.ok(doc);
    assert.equal(doc.deleted_at, null);
    assert.equal(doc.deleted_by, null);
  });

  it('rejects restore from a non-admin non-creator caller', async () => {
    const { handleRestoreMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');

    await writeRuntimeDoc('job_restore_forbidden', {
      tenant_id: 'tenant_acme',
      created_by: 'user_other',
      deleted_at: '2026-04-16T00:00:00.000Z',
      deleted_by: 'user_other',
    });

    const response = await handleRestoreMarketingJob('job_restore_forbidden', async () => ({
      userId: 'user_analyst',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_analyst',
    }));

    assert.equal(response.status, 403);
  });

  it('is idempotent on a live (not-deleted) campaign: returns 200 without mutating state', async () => {
    const { handleRestoreMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/delete/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    await writeRuntimeDoc('job_restore_idempotent', {
      tenant_id: 'tenant_acme',
      created_by: 'user_admin',
      // Note: deleted_at is null — the campaign is already live.
    });

    const response = await handleRestoreMarketingJob('job_restore_idempotent', async () => ({
      userId: 'user_admin',
      tenantId: 'tenant_acme',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));

    assert.equal(response.status, 200);
    const doc = await loadMarketingJobRuntime('job_restore_idempotent');
    assert.ok(doc);
    assert.equal(doc.deleted_at, null);
    assert.equal(doc.deleted_by, null);
  });
});
