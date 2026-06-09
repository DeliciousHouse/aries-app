/**
 * PR2 Phase 3 — flag-ON call-site WIRING for the post-edit taste producer.
 *
 * The producer units (recordPostEditTasteSignal / recordStyleVibeTasteSignal)
 * are unit-tested with injected deps in tests/marketing/review-edit-taste.test.ts.
 * What those CANNOT prove is that the two real call sites actually forward the
 * right (dimension, value, outcome) into the producer when the flag is ON,
 * because both call sites invoke the producer with NO injected deps — they ride
 * the real env flag (isPostEditTasteLearningEnabled) and the real writer
 * (applyTenantTasteSignal, which uses the GLOBAL pg pool). The pre-existing
 * route tests sidestep this:
 *   - tests/social-content-cancel-schedule.test.ts runs flag-OFF and returns post
 *     rows WITHOUT the style columns, so the SELECT-widen + forward path is dark;
 *   - tests/regenerate-creative.test.ts uses a brand kit with style_vibe:null, so
 *     recordStyleVibeTasteSignal always no-ops.
 *
 * This file closes that gap. It installs a recording mock pool via
 * globalThis.__ariesPgPool (the hook lib/db.ts reads at first import — see
 * tests/marketing/pending-approval-count-denorm.test.ts), flips
 * ARIES_POST_EDIT_TASTE_LEARNING_ENABLED on, and asserts each call site forwards
 * the stamped visual-style lens into a tenant-scoped INSERT INTO
 * marketing_taste_profile with the mapped (rejected) delta. The flag-OFF twin of
 * each case proves the gate is wired at the call site (style data present, yet
 * no DB write).
 *
 * Implementation note: lib/db.ts binds `pool` ONCE at first import
 * (globalThis.__ariesPgPool ?? createPool()). So the mock is installed at module
 * scope BEFORE any dynamic import, and every test clears its `calls` rather than
 * swapping the object (a swapped object would not rebind the already-resolved
 * `pool` const). All app modules are dynamic-imported inside the tests so nothing
 * loads lib/db before the mock is in place.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { Pool } from 'pg';
import type {
  MarketingExecutionPort,
  MarketingExecutionResult,
  MarketingPipelineRunInput,
} from '../../backend/marketing/execution-port';
import type { MarketingBrandKitReference } from '../../backend/marketing/runtime-state';

type QueryCall = { sql: string; params: unknown[] };

// Single shared recording pool installed BEFORE any dynamic import so lib/db's
// one-time `pool` binding resolves to it. `calls` is cleared per test.
const calls: QueryCall[] = [];
const g = globalThis as typeof globalThis & { __ariesPgPool?: Pool };
const prevPool = g.__ariesPgPool;
g.__ariesPgPool = {
  query(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    // applyTenantTasteSignal expects the upsert RETURNING (dimensions, updated_at).
    return Promise.resolve({
      rows: [{ dimensions: {}, updated_at: new Date('2026-06-09T00:00:00.000Z') }],
      rowCount: 1,
    });
  },
} as unknown as Pool;

after(() => {
  if (prevPool === undefined) delete g.__ariesPgPool;
  else g.__ariesPgPool = prevPool;
});

/** All taste-profile upserts the producer issued on the global pool this test. */
function tasteInserts(): QueryCall[] {
  return calls.filter((c) => /INSERT INTO marketing_taste_profile/i.test(c.sql));
}

function withTasteFlag(value: '1' | '0' | undefined): () => void {
  const prev = process.env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED;
  if (value === undefined) delete process.env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED;
  else process.env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED = value;
  return () => {
    if (prev === undefined) delete process.env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED;
    else process.env.ARIES_POST_EDIT_TASTE_LEARNING_ENABLED = prev;
  };
}

function tenantLoader(tenantId: number) {
  return async () => ({
    userId: '1001',
    tenantId: String(tenantId),
    tenantSlug: `tenant-${tenantId}`,
    role: 'tenant_admin' as const,
  });
}

// A delete-route queryable that returns the WIDENED post row (with the stamped
// style lens) the PR2 SELECT captures, and satisfies the cascade deletes. The
// taste INSERT does NOT come through here — it rides the global pool.
function buildPostQueryableWithStyle(style: { dimension: string | null; value: string | null }) {
  const localCalls: QueryCall[] = [];
  const query = async (sql: string, params: unknown[]) => {
    const trimmed = sql.trim();
    localCalls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id')) {
      const [postId, tenantId] = params as [number, number];
      return {
        rows: [
          {
            id: postId,
            tenant_id: tenantId,
            style_dimension: style.dimension,
            style_value: style.value,
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith('SELECT dispatch_status FROM scheduled_posts')) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith('DELETE FROM scheduled_posts')) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith('DELETE FROM posts')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${trimmed}`);
  };
  return { queryable: { query }, calls: localCalls };
}

// ---------------------------------------------------------------------------
// Delete route (handleDeleteSocialContentPost) — recordPostEditTasteSignal
// forwards deletedPostRow.style_dimension/style_value as a 'rejected' signal.
// ---------------------------------------------------------------------------

test('delete route forwards the stamped visual_style lens into a rejected tenant taste INSERT (flag ON)', async () => {
  calls.length = 0;
  const restoreFlag = withTasteFlag('1');
  try {
    const { handleDeleteSocialContentPost } = await import(
      '../../app/api/social-content/jobs/[jobId]/posts/[postId]/route'
    );
    const { queryable } = buildPostQueryableWithStyle({ dimension: 'visual_style', value: 'Quiet Luxury' });

    const response = await handleDeleteSocialContentPost('job-del-taste', '42', {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    });

    // The operator action must still succeed (the taste write rides on it).
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.postDeleted, true);

    const inserts = tasteInserts();
    assert.equal(inserts.length, 1, 'exactly one tenant taste signal written on delete');
    // Tenant-scoped INSERT params: [tid, dimension, value, approvedDelta, rejectedDelta, nowIso].
    const params = inserts[0]!.params;
    assert.equal(params[0], 15, 'tenant id forwarded (numeric)');
    assert.equal(params[1], 'visual_style', 'dimension forwarded from the widened SELECT');
    assert.equal(params[2], 'Quiet Luxury', 'value forwarded from the widened SELECT');
    assert.equal(params[3], 0, 'approved delta is 0 (delete maps to rejected)');
    assert.equal(params[4], 1, 'rejected delta is 1');
  } finally {
    restoreFlag();
  }
});

test('delete route writes NO taste signal when the flag is OFF, even with style columns present', async () => {
  calls.length = 0;
  const restoreFlag = withTasteFlag('0');
  try {
    const { handleDeleteSocialContentPost } = await import(
      '../../app/api/social-content/jobs/[jobId]/posts/[postId]/route'
    );
    const { queryable } = buildPostQueryableWithStyle({ dimension: 'visual_style', value: 'Quiet Luxury' });

    const response = await handleDeleteSocialContentPost('job-del-off', '42', {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    });

    assert.equal(response.status, 200, 'delete still succeeds with the flag OFF');
    assert.equal(
      tasteInserts().length,
      0,
      'flag OFF => the env gate stops the write at the call site (style data present, no INSERT)',
    );
  } finally {
    restoreFlag();
  }
});

// ---------------------------------------------------------------------------
// Regenerate (regenerateCreativeAsNewRun) — recordStyleVibeTasteSignal forwards
// brand_kit.style_vibe as a 'rejected' visual_style signal after a submit.
// ---------------------------------------------------------------------------

const REGEN_BRAND_URL = 'https://brand.regen-taste.example/';

function buildBrandKitWithVibe(styleVibe: string | null): MarketingBrandKitReference {
  return {
    path: '/tmp/brand-kit-regen-taste.json',
    source_url: REGEN_BRAND_URL,
    canonical_url: REGEN_BRAND_URL,
    brand_name: 'Regen Taste Brand',
    logo_urls: [],
    colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [],
    external_links: [],
    extracted_at: new Date('2026-06-09T00:00:00.000Z').toISOString(),
    brand_voice_summary: null,
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: styleVibe,
  };
}

class StubMarketingPort implements MarketingExecutionPort {
  readonly name = 'hermes' as const;
  public capturedRuns: MarketingPipelineRunInput[] = [];
  async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
    this.capturedRuns.push(input);
    return {
      kind: 'submitted',
      provider: 'hermes',
      ariesRunId: 'arun_regen_taste_new',
      hermesRunId: 'hermes_run_regen_taste',
    };
  }
  async resumePipeline(): Promise<MarketingExecutionResult> {
    throw new Error('resumePipeline should not be called for regenerate flow');
  }
  async submitNextStage(): Promise<MarketingExecutionResult> {
    return { kind: 'submitted', provider: 'hermes', ariesRunId: 'arun_stub_next' };
  }
  getCallbackUrl() {
    return 'https://aries.example.com/api/internal/hermes/runs';
  }
  getSessionKey() {
    return 'marketing';
  }
  async submitRawRun(): Promise<import('../../backend/marketing/execution-port').SubmitRawRunResult> {
    throw new Error('submitRawRun should not be called in regenerate flow');
  }
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-regen-taste-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedRegenDoc(jobId: string, tenantId: string, sourceRunId: string, styleVibe: string | null) {
  const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } = await import(
    '../../backend/marketing/runtime-state'
  );
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: REGEN_BRAND_URL,
      websiteUrl: REGEN_BRAND_URL,
      businessType: 'Test vertical',
      businessName: 'Regen Taste Brand',
    },
    brandKit: buildBrandKitWithVibe(styleVibe),
    createdBy: 'user_regen_taste',
  });
  doc.stages.research.run_id = sourceRunId;
  doc.stages.research.status = 'completed';
  doc.stages.production.run_id = sourceRunId;
  saveSocialContentJobRuntime(jobId, doc);
}

test('regenerate forwards brand_kit.style_vibe into a rejected visual_style tenant taste INSERT (flag ON)', async () => {
  await withDataRoot(async () => {
    calls.length = 0;
    const restoreFlag = withTasteFlag('1');
    try {
      const { regenerateCreativeAsNewRun } = await import('../../backend/marketing/regenerate-creative');
      const jobId = 'mkt_regen_taste_on';
      const tenantId = '15';
      const sourceRunId = 'arun_regen_taste_source';
      await seedRegenDoc(jobId, tenantId, sourceRunId, 'Bold Minimalist');

      const port = new StubMarketingPort();
      const result = await regenerateCreativeAsNewRun({
        jobId,
        creativeId: 'creative_regen_taste',
        tenantId,
        sourceRunId,
        port,
      });

      assert.equal(result.kind, 'submitted', 'regenerate still submits (taste write rides on it)');

      const inserts = tasteInserts();
      assert.equal(inserts.length, 1, 'exactly one tenant taste signal written on regenerate');
      const params = inserts[0]!.params;
      assert.equal(params[0], 15, 'tenant id forwarded (numeric)');
      assert.equal(params[1], 'visual_style', 'regenerate teaches on the visual_style lens');
      assert.equal(params[2], 'Bold Minimalist', 'value forwarded from brand_kit.style_vibe');
      assert.equal(params[3], 0, 'approved delta is 0 (regenerate maps to rejected)');
      assert.equal(params[4], 1, 'rejected delta is 1');
    } finally {
      restoreFlag();
    }
  });
});

test('regenerate writes NO taste signal when the flag is OFF, even with a non-null style_vibe', async () => {
  await withDataRoot(async () => {
    calls.length = 0;
    const restoreFlag = withTasteFlag('0');
    try {
      const { regenerateCreativeAsNewRun } = await import('../../backend/marketing/regenerate-creative');
      const jobId = 'mkt_regen_taste_off';
      const tenantId = '15';
      const sourceRunId = 'arun_regen_taste_off_source';
      await seedRegenDoc(jobId, tenantId, sourceRunId, 'Bold Minimalist');

      const port = new StubMarketingPort();
      const result = await regenerateCreativeAsNewRun({
        jobId,
        creativeId: 'creative_regen_taste_off',
        tenantId,
        sourceRunId,
        port,
      });

      assert.equal(result.kind, 'submitted', 'regenerate still submits with the flag OFF');
      assert.equal(
        tasteInserts().length,
        0,
        'flag OFF => the env gate stops the write at the call site (style_vibe present, no INSERT)',
      );
    } finally {
      restoreFlag();
    }
  });
});
