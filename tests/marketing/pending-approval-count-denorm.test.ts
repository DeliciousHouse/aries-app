import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';
import type { ExecutionRunRecord } from '../../backend/execution/run-store';
import { resolveProjectRoot } from '../helpers/project-root';

// Write-time denormalization guard for the campaign-list "pending approvals"
// badge (perf(social-content): persist pending_approval_count).
//
// The list path now reads record.pending_approval_count O(1) instead of
// re-hydrating every job to count review items. Correctness hinges on every
// mutation that can change the count recomputing + persisting it. The golden
// invariant asserted EVERYWHERE here:
//
//   persisted pending_approval_count == live re-hydrating oracle
//     (recomputeAndPersistPendingApprovalCount == buildReviewItemsForJob count)
//
// These tests drive the REAL write sites:
//   - applyHermesMarketingCallback (Hermes stage advance + production
//     creative_assets ingestion that writes the DB directly)
//   - recordMarketingReviewDecision rejecting a DB-only creative asset
//     (the v0.1.13.7 under-count vector -- mergeReviewState overrides the DB
//     asset's 'approved' payload with the persisted 'rejected' decision)
//   - the list read-through fallback self-heals a legacy record.

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type QueryCall = { sql: string; params: unknown[] };

// Recording mock pool injected via globalThis.__ariesPgPool (the hook lib/db.ts
// uses). The creative_assets SELECT returns one DB-only production asset so the
// workspace view surfaces a DB-only creative review item -- the exact shape the
// rejected-DB-only-asset oracle case needs. No live DB required.
function installMockPool(): { calls: QueryCall[]; servedRef: { value: string }; restore: () => void } {
  const calls: QueryCall[] = [];
  // Mutable so a test can drift the DB-only asset's served_asset_ref (which
  // feeds reviewItemSourceHash) to exercise the source-hash-drift reset.
  const servedRef = { value: '/api/internal/hermes/media/openai_codex_a.png' };
  const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
  const prev = g.__ariesPgPool;
  g.__ariesPgPool = {
    query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*FROM creative_assets/i.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              id: 'uuid-1',
              source_asset_id: 'img_1',
              served_asset_ref: servedRef.value,
            },
          ],
          rowCount: 1,
        });
      }
      if (/SELECT[\s\S]*FROM posts/i.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [{ id: 'row-1' }], rowCount: 1 });
    },
  } as unknown as Pool;
  return {
    calls,
    servedRef,
    restore: () => {
      if (prev === undefined) delete g.__ariesPgPool;
      else g.__ariesPgPool = prev;
    },
  };
}

function makeStage(name: string, status: string, primaryOutput: unknown = null) {
  return {
    stage: name,
    status,
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: primaryOutput,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

function makeProductionRunningDoc(jobId: string): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: '42',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: makeStage('research', 'completed'),
      strategy: makeStage('strategy', 'completed'),
      production: makeStage('production', 'in_progress'),
      publish: makeStage('publish', 'not_started'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Test Brand',
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
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: {}, brand_url: 'https://example.com' },
    history: [],
    errors: [],
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as SocialContentJobRuntimeDocument;
}

// requires_approval production callback carrying one creative_asset image.
function makeProductionApprovalPayload() {
  return {
    status: 'requires_approval',
    stage: 'production',
    hermes_run_id: 'hermes_run_prod',
    output: [
      {
        stage: 'production',
        artifacts: {
          creative_assets: [
            {
              assetId: 'img_1',
              type: 'generated_image',
              path: '/home/node/.hermes/profiles/aries-content-generator/cache/images/openai_codex_a.png',
            },
          ],
          errors: [],
        },
      },
    ],
    approval: {
      stage: 'production',
      workflowStepId: 'approve_stage_3',
      prompt: 'Production complete. Approve to continue.',
      resumeToken: 'resume_production',
    },
  };
}

function makeRunRecord(jobId: string): ExecutionRunRecord {
  return {
    schema_name: 'aries_execution_run',
    schema_version: '1.0.0',
    aries_run_id: 'arun_test_denorm',
    provider: 'hermes',
    domain: 'marketing',
    workflow_key: 'marketing_pipeline',
    action: 'run',
    tenant_id: '42',
    marketing_job_id: jobId,
    approval_id: null,
    stage: 'production',
    workflow_step_id: null,
    external_run_id: 'hermes_run_prod',
    status: 'requires_approval',
    event_ids: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    result: null,
  } as unknown as ExecutionRunRecord;
}

// The golden invariant: the persisted scalar equals the live re-hydrating oracle.
async function assertPersistedMatchesOracle(jobId: string, tenantId: string): Promise<number> {
  const views = await import('../../backend/marketing/runtime-views');
  const store = await import('../../backend/marketing/workspace-store');

  const oracleItems = await views.listMarketingReviewItemsForTenant(tenantId);
  const oracle = oracleItems.filter((item) => item.status !== 'approved').length;

  const record = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
  assert.ok(record, 'workspace record must exist');
  assert.equal(
    record!.pending_approval_count,
    oracle,
    'persisted pending_approval_count must equal the live oracle count',
  );

  const recomputed = await views.recomputeAndPersistPendingApprovalCount(jobId);
  assert.equal(recomputed, oracle, 'recompute helper must equal the live oracle count');
  return oracle;
}

async function withEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevCodeRoot = process.env.CODE_ROOT;
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const prevAutoApprove = process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-denorm-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.HERMES_IMAGE_CACHE_MOUNT = dataRoot;
  // Keep the checkpoint a human gate so the badge reflects a pending approval.
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '0';
  try {
    return await run(dataRoot);
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCodeRoot;
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    if (prevAutoApprove === undefined) delete process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE;
    else process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = prevAutoApprove;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('write site: Hermes production-approval callback persists pending_approval_count == oracle', async () => {
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');

      const jobId = 'mkt_denorm_callback';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));

      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // The callback advanced the stage to an approval checkpoint and ingested
      // the production creative asset; its wrapper recomputed + persisted the
      // count. It must equal the live oracle, and be > 0 (an approval is pending).
      const oracle = await assertPersistedMatchesOracle(jobId, tenantId);
      assert.ok(oracle > 0, 'a pending production approval must make the badge > 0');
    } finally {
      mock.restore();
    }
  });
});

test('write site: rejecting a DB-only creative asset keeps persisted count == oracle (v0.1.13.7 vector)', async () => {
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');

      const jobId = 'mkt_denorm_reject';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // The DB-only creative asset is surfaced by the workspace view's
      // creative_assets DB merge with payload status 'approved' (so it is
      // correctly absent from the non-approved review QUEUE). Reject it directly
      // by its deterministic review id. recordMarketingReviewDecision ->
      // setCreativeAssetDecision persists 'rejected'; mergeReviewState must then
      // override the DB asset's 'approved' payload with that decision, so the
      // live oracle count rises by one. This is the exact under-count vector the
      // v0.1.13.7 skip-the-merge attempt got WRONG.
      const reviewId = `${jobId}::creative:img_1`;
      const beforeOracle = (await views.listMarketingReviewItemsForTenant(tenantId)).filter(
        (item) => item.status !== 'approved',
      ).length;

      const decided = await views.recordMarketingReviewDecision({
        tenantId,
        reviewId,
        action: 'reject',
        actedBy: 'Brendan',
        note: 'Off-brand -- regenerate.',
      });
      assert.ok(decided, 'reject decision on the DB-only creative asset must resolve');
      assert.equal(decided!.status, 'rejected', 'the creative asset must be rejected');

      const afterOracle = (await views.listMarketingReviewItemsForTenant(tenantId)).filter(
        (item) => item.status !== 'approved',
      ).length;
      assert.ok(
        afterOracle > beforeOracle,
        'rejecting a previously-approved DB-only asset must raise the live oracle count',
      );

      // After the reject, persisted == oracle. This is the exact case the
      // v0.1.13.7 skip-the-merge attempt got WRONG (under-counted).
      await assertPersistedMatchesOracle(jobId, tenantId);
    } finally {
      mock.restore();
    }
  });
});

test('read-through fallback: a record missing pending_approval_count self-heals on list load', async () => {
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');
      const store = await import('../../backend/marketing/workspace-store');

      const jobId = 'mkt_denorm_legacy';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // Simulate a legacy record predating the field: strip the scalar.
      const legacy = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
      assert.ok(legacy, 'record must exist');
      legacy!.pending_approval_count = undefined;
      store.saveSocialContentWorkspaceRecord(legacy!);
      assert.equal(
        store.loadSocialContentWorkspaceRecord(jobId, tenantId)!.pending_approval_count,
        undefined,
        'precondition: scalar absent',
      );

      // A list load must self-heal: derive the count, persist it, and surface it
      // on the card -- all equal to the live oracle.
      const { posts } = await views.listSocialContentJobsForTenant(tenantId);
      assert.equal(posts.length, 1, 'one campaign expected');
      const oracle = (await views.listMarketingReviewItemsForTenant(tenantId)).filter(
        (item) => item.status !== 'approved',
      ).length;
      assert.equal(posts[0].pendingApprovals, oracle, 'card count == oracle after self-heal');
      assert.equal(
        store.loadSocialContentWorkspaceRecord(jobId, tenantId)!.pending_approval_count,
        oracle,
        'scalar persisted (self-healed) after the list load',
      );
    } finally {
      mock.restore();
    }
  });
});

test('write site: brand-asset upload to an existing workspace keeps persisted count == oracle (#521 gap)', async () => {
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');
      const store = await import('../../backend/marketing/workspace-store');

      const jobId = 'mkt_denorm_brandupload';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);
      await assertPersistedMatchesOracle(jobId, tenantId);

      // The brief/create routes mutate brand assets via saveSocialContentWorkspaceAssets,
      // which can change brand-review-item existence (uploadedBrandAssets(record)).
      // Those routes now call recomputeAndPersistPendingApprovalCount after the save;
      // without it the persisted scalar would go stale (the Copilot #521 gap).
      const record = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
      assert.ok(record, 'workspace record must exist');
      store.saveSocialContentWorkspaceAssets(record!, [
        { name: 'logo.png', contentType: 'image/png', data: Buffer.from('logo') },
      ]);
      store.saveSocialContentWorkspaceRecord(record!);
      await views.recomputeAndPersistPendingApprovalCount(jobId);

      // Persisted scalar still equals the live oracle after the brand-asset mutation.
      await assertPersistedMatchesOracle(jobId, tenantId);
    } finally {
      mock.restore();
    }
  });
});

test('write site: source-hash drift on an approved DB asset re-pends it and persisted count tracks oracle', async () => {
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');

      const jobId = 'mkt_denorm_drift';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // The DB-only asset's payload status is 'approved'; the first review-items
      // build records that approved status under its source hash in the
      // persisted review state (mergeReviewState). Establish that baseline via a
      // recompute -- NO API approve (which would advance the stage and need a
      // Hermes port). The asset is now an 'approved' creative with a known hash.
      await assertPersistedMatchesOracle(jobId, tenantId);

      // DRIFT: the DB asset's served_asset_ref changes (e.g. regenerated image),
      // changing reviewItemSourceHash. mergeReviewState must reset the prior
      // 'approved' to 'in_review' (non-approved) -> the count rises by one, and a
      // recompute must persist that new count, still equal to the live oracle.
      mock.servedRef.value = '/api/internal/hermes/media/openai_codex_REGENERATED.png';
      const oracleAfterDrift = (await views.listMarketingReviewItemsForTenant(tenantId)).filter(
        (item) => item.status !== 'approved',
      ).length;
      const persistedAfterDrift = await views.recomputeAndPersistPendingApprovalCount(jobId);
      assert.equal(
        persistedAfterDrift,
        oracleAfterDrift,
        'persisted count must equal the live oracle after a source-hash drift reset',
      );
      await assertPersistedMatchesOracle(jobId, tenantId);
    } finally {
      mock.restore();
    }
  });
});

test('list queue: count==0 jobs are skipped, but the skip path matches a full rebuild', async () => {
  // Guards the O(jobs-with-pending) optimization in listMarketingReviewQueueForTenant:
  // a job whose persisted pending_approval_count is 0 must be excluded WITHOUT
  // re-hydrating its workspace view, and the resulting queue must be identical
  // to building every job from scratch (no skip). Relies on the #521 invariant
  // (persisted == live oracle), which the write-site tests above maintain.
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');
      const store = await import('../../backend/marketing/workspace-store');

      const tenantId = '42';
      const jobId = 'mkt_queue_pending';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // Full-rebuild oracle: strip the persisted count so the queue builder takes
      // the build-everything path (no skip), then snapshot the queue ids.
      const stripped = store.loadSocialContentWorkspaceRecord(jobId, tenantId)!;
      stripped.pending_approval_count = undefined;
      store.saveSocialContentWorkspaceRecord(stripped);
      const fullRebuild = (await views.listMarketingReviewQueueForTenant(tenantId)).reviews
        .map((r) => r.id)
        .sort();
      assert.ok(fullRebuild.length > 0, 'a pending production approval must yield a non-empty queue');

      // The list load above self-healed the count. The steady-state (skip) path
      // must produce the identical queue.
      const skipPath = (await views.listMarketingReviewQueueForTenant(tenantId)).reviews
        .map((r) => r.id)
        .sort();
      assert.deepEqual(skipPath, fullRebuild, 'skip-path queue must equal the full-rebuild queue');

      // Force the persisted count to 0 (simulate an all-approved job). The job
      // must drop from the queue — proving count==0 short-circuits the heavy
      // getMarketingJobStatus + buildSocialContentWorkspaceView hydration.
      const zeroed = store.loadSocialContentWorkspaceRecord(jobId, tenantId)!;
      zeroed.pending_approval_count = 0;
      store.saveSocialContentWorkspaceRecord(zeroed);
      const afterZero = (await views.listMarketingReviewQueueForTenant(tenantId)).reviews;
      assert.equal(afterZero.length, 0, 'a count==0 job is skipped and contributes nothing to the queue');
    } finally {
      mock.restore();
    }
  });
});

test('dashboard projection: persisted list row + tenant dashboard equal a fresh rebuild (byte-identical)', async () => {
  // Golden invariant for the write-time dashboard_list_projection denorm: the
  // O(1) list path that reads the persisted projection must produce output
  // byte-identical to a from-scratch rebuild. Also proves the referenceDate pin
  // removes calendar drift (the persisted snapshot is built at callback time;
  // the rebuild happens later — they must still match).
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');
      const wsViews = await import('../../backend/marketing/workspace-views');
      const store = await import('../../backend/marketing/workspace-store');

      const jobId = 'mkt_denorm_dashboard';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      // The callback's recompute wrapper persisted the dashboard projection.
      const record = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
      assert.ok(record?.dashboard_list_projection, 'callback must persist dashboard_list_projection');

      // Endpoint-2 (campaign list) + endpoint-1 (tenant dashboard) served from the
      // persisted projection (the O(1) fast path).
      const fromProjection = (await views.listSocialContentJobsForTenant(tenantId)).posts;
      const dashFromProjection = await wsViews.getWorkflowAwareDashboardContentForTenant(tenantId);
      assert.equal(fromProjection.length, 1, 'one campaign expected');

      // Force a from-scratch rebuild for endpoint 2: strip the projection, re-list
      // (the self-heal rebuilds it via buildSocialContentWorkspaceView).
      const strip = () => {
        const r = store.loadSocialContentWorkspaceRecord(jobId, tenantId)!;
        r.dashboard_list_projection = undefined;
        store.saveSocialContentWorkspaceRecord(r);
      };
      strip();
      const rebuilt = (await views.listSocialContentJobsForTenant(tenantId)).posts;
      strip();
      const dashRebuilt = await wsViews.getWorkflowAwareDashboardContentForTenant(tenantId);

      assert.deepEqual(
        fromProjection,
        rebuilt,
        'campaign-list rows from the persisted projection must equal a fresh rebuild',
      );
      assert.deepEqual(
        dashFromProjection,
        dashRebuilt,
        'tenant dashboard from the persisted projection must equal a fresh rebuild',
      );
    } finally {
      mock.restore();
    }
  });
});

test('staleness guard: a projection whose sourceUpdatedAt no longer matches the runtime doc is rebuilt, not served stale', async () => {
  // Adversarial-review regression: the fast read path must NOT serve a present-but-
  // STALE projection. Several write sites mutate the runtime doc WITHOUT recomputing
  // the projection — the stale-run reaper (default-ON, every 5 min) flips state to
  // failed_stale, orchestrator transitions flip to running/failed — each bumping
  // runtimeDoc.updated_at. The freshness stamp (sourceUpdatedAt) makes the read path
  // notice the mismatch and rebuild, so a reaped job never keeps rendering its old
  // 'running' card. Here we corrupt the stamp directly (deterministic, no save-timing
  // dependency) to simulate any such bypassing write.
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime, loadSocialContentJobRuntime } = await import(
        '../../backend/marketing/runtime-state'
      );
      const { applyHermesMarketingCallback } = await import('../../backend/marketing/hermes-callbacks');
      const views = await import('../../backend/marketing/runtime-views');
      const store = await import('../../backend/marketing/workspace-store');

      const jobId = 'mkt_denorm_stale';
      const tenantId = '42';
      saveSocialContentJobRuntime(jobId, makeProductionRunningDoc(jobId));
      await applyHermesMarketingCallback(makeRunRecord(jobId), makeProductionApprovalPayload() as never);

      const doc = await loadSocialContentJobRuntime(jobId);
      assert.ok(doc, 'runtime doc must exist');
      const rec = store.loadSocialContentWorkspaceRecord(jobId, tenantId);
      assert.ok(rec?.dashboard_list_projection, 'callback must persist a projection');
      assert.equal(
        rec!.dashboard_list_projection!.sourceUpdatedAt,
        doc!.updated_at,
        'a fresh projection is stamped with the current runtimeDoc.updated_at',
      );

      // Simulate a runtime-doc write that bypassed recompute: stamp goes stale.
      rec!.dashboard_list_projection!.sourceUpdatedAt = '1970-01-01T00:00:00.000Z';
      store.saveSocialContentWorkspaceRecord(rec!);

      // The fast path must rebuild (stamp mismatch), not serve the stale projection.
      const served = (await views.listSocialContentJobsForTenant(tenantId)).posts;
      assert.equal(served.length, 1, 'one campaign expected');

      // Self-heal: the persisted stamp is restored to the live updated_at.
      assert.equal(
        store.loadSocialContentWorkspaceRecord(jobId, tenantId)!.dashboard_list_projection!.sourceUpdatedAt,
        doc!.updated_at,
        'stale projection self-heals: stamp restored to runtimeDoc.updated_at',
      );

      // And the rebuilt-from-stale row equals a from-scratch rebuild (correct value).
      const r2 = store.loadSocialContentWorkspaceRecord(jobId, tenantId)!;
      r2.dashboard_list_projection = undefined;
      store.saveSocialContentWorkspaceRecord(r2);
      const freshRebuild = (await views.listSocialContentJobsForTenant(tenantId)).posts;
      assert.deepEqual(served, freshRebuild, 'rebuilt-from-stale row must equal a fresh rebuild');
    } finally {
      mock.restore();
    }
  });
});

test('robustness: a malformed created_at does not throw (referenceDate parse guard)', async () => {
  // Adversarial-review regression: loadSocialContentJobRuntime never validates
  // created_at, so a legacy/partial doc can carry a malformed value. The projection
  // build pins referenceDate to created_at; an unguarded `new Date(bad)` threw
  // RangeError at .toISOString() and, via processConcurrent re-throw, 500-ed the
  // WHOLE tenant list. The guard must fall back to wall-clock and still list the job.
  await withEnv(async (dataRoot) => {
    const mock = installMockPool();
    try {
      await writeFile(path.join(dataRoot, 'openai_codex_a.png'), Buffer.from('a'));
      const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
      const views = await import('../../backend/marketing/runtime-views');

      const jobId = 'mkt_denorm_badcreated';
      const tenantId = '42';
      const doc = makeProductionRunningDoc(jobId);
      (doc as unknown as { created_at: string }).created_at = 'not-a-real-date';
      saveSocialContentJobRuntime(jobId, doc);

      // Must not throw — degrades to wall-clock and still surfaces the campaign.
      const { posts } = await views.listSocialContentJobsForTenant(tenantId);
      assert.equal(posts.length, 1, 'job still lists despite a malformed created_at');
    } finally {
      mock.restore();
    }
  });
});
