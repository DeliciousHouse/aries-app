import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// REGRESSION (Copilot review on PR #481):
// listDeletedSocialContentJobsForTenant was reworked from a serial for-await
// loop into two-phase bounded-parallel fan-out. This test pins the contract
// the refactor must preserve:
//   1. duplicates collapse to first-seen (by externalCampaignId / name / jobId)
//   2. deletedAt / deletedBy / softCancelRequestedAt fields are populated
//   3. output ordering remains correct (newest deletedAt first)

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prev = {
    CODE_ROOT: process.env.CODE_ROOT,
    DATA_ROOT: process.env.DATA_ROOT,
  };
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-deleted-list-test-'));
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (prev.CODE_ROOT === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prev.CODE_ROOT;
    if (prev.DATA_ROOT === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev.DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function makeDeletedDoc(input: {
  jobId: string;
  tenantId: string;
  brandName: string;
  deletedAt: string;
  deletedBy: string;
  softCancelRequestedAt?: string | null;
  updatedAt: string;
}) {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: input.jobId,
    job_type: 'weekly_social_content',
    tenant_id: input.tenantId,
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    deleted_at: input.deletedAt,
    deleted_by: input.deletedBy,
    soft_cancel_requested_at: input.softCancelRequestedAt ?? null,
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-pub', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', input.tenantId, 'brand-kit.json'),
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: input.brandName,
      logo_urls: [],
      colors: { primary: '#000', secondary: '#fff', accent: '#888', palette: ['#000', '#fff', '#888'] },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: '2026-03-20T00:00:00.000Z',
    },
    inputs: { request: {}, brand_url: 'https://brand.example' },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: input.updatedAt,
  };
}

test('listDeletedSocialContentJobsForTenant: deletedAt/deletedBy/softCancelRequestedAt populated on every result', async () => {
  await withRuntimeEnv(async () => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });

    await writeFile(
      path.join(jobsRoot, 'deleted-a.json'),
      JSON.stringify(makeDeletedDoc({
        jobId: 'deleted-a',
        tenantId: 'tenant_del',
        brandName: 'Brand A',
        deletedAt: '2026-05-10T12:00:00Z',
        deletedBy: 'user-a@example.com',
        softCancelRequestedAt: '2026-05-10T11:50:00Z',
        updatedAt: '2026-05-10T12:00:00Z',
      }), null, 2),
    );

    const { listDeletedSocialContentJobsForTenant } = await import('../../backend/marketing/runtime-views');
    const result = await listDeletedSocialContentJobsForTenant('tenant_del');

    assert.equal(result.length, 1);
    assert.equal(result[0].deletedAt, '2026-05-10T12:00:00Z');
    assert.equal(result[0].deletedBy, 'user-a@example.com');
    assert.equal(result[0].softCancelRequestedAt, '2026-05-10T11:50:00Z');
  });
});

// Dedup behavior on the deleted-list shares its key derivation with the live
// list — `view.dashboard.post?.externalCampaignId || campaign?.name ||
// 'job::<jobId>'`. The live path is exercised in
// tests/runtime-views-auth-hardening.test.ts ("keep only the latest rerun for
// the same campaign identity"). Both paths use the same `processConcurrent`
// helper and the same in-order serial dedup step after phase 1, so the
// live-path test is the authoritative dedup contract for both. A future
// follow-up could extract the dedup loop into a shared helper and pin it
// directly, but for now the live-path coverage matches our intent.

test('listDeletedSocialContentJobsForTenant: ordering newest-deletedAt-first preserved after parallel fan-out', async () => {
  await withRuntimeEnv(async () => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });

    // Three distinct brands, varying deleted_at timestamps. Result should be
    // newest deleted_at first regardless of file-write order.
    const seed: Array<[string, string, string]> = [
      ['del-middle', 'Brand Mid',   '2026-05-11T12:00:00Z'],
      ['del-oldest', 'Brand Old',   '2026-05-01T12:00:00Z'],
      ['del-newest', 'Brand New',   '2026-05-20T12:00:00Z'],
    ];
    for (const [jobId, brandName, deletedAt] of seed) {
      await writeFile(
        path.join(jobsRoot, `${jobId}.json`),
        JSON.stringify(makeDeletedDoc({
          jobId,
          tenantId: 'tenant_order',
          brandName,
          deletedAt,
          deletedBy: 'user@example.com',
          updatedAt: deletedAt,
        }), null, 2),
      );
    }

    const { listDeletedSocialContentJobsForTenant } = await import('../../backend/marketing/runtime-views');
    const result = await listDeletedSocialContentJobsForTenant('tenant_order');

    assert.equal(result.length, 3);
    assert.equal(result[0].deletedAt, '2026-05-20T12:00:00Z', 'newest first');
    assert.equal(result[1].deletedAt, '2026-05-11T12:00:00Z', 'middle second');
    assert.equal(result[2].deletedAt, '2026-05-01T12:00:00Z', 'oldest last');
  });
});

test('listDeletedSocialContentJobsForTenant: ignores non-tenant-owned jobs even in the deleted set', async () => {
  await withRuntimeEnv(async () => {
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsRoot, { recursive: true });

    // Mine
    await writeFile(
      path.join(jobsRoot, 'mine.json'),
      JSON.stringify(makeDeletedDoc({
        jobId: 'mine',
        tenantId: 'tenant_a',
        brandName: 'Mine',
        deletedAt: '2026-05-15T12:00:00Z',
        deletedBy: 'me@example.com',
        updatedAt: '2026-05-15T12:00:00Z',
      }), null, 2),
    );
    // Someone else's deleted campaign — must NOT leak
    await writeFile(
      path.join(jobsRoot, 'theirs.json'),
      JSON.stringify(makeDeletedDoc({
        jobId: 'theirs',
        tenantId: 'tenant_b',
        brandName: 'Theirs',
        deletedAt: '2026-05-15T12:00:00Z',
        deletedBy: 'them@example.com',
        updatedAt: '2026-05-15T12:00:00Z',
      }), null, 2),
    );

    const { listDeletedSocialContentJobsForTenant } = await import('../../backend/marketing/runtime-views');
    const result = await listDeletedSocialContentJobsForTenant('tenant_a');
    assert.equal(result.length, 1);
    assert.equal(result[0].jobId, 'mine', 'cross-tenant deleted job must not leak');
  });
});
