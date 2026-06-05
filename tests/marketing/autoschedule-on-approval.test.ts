/**
 * Piece A — auto-schedule on publish approval, decoupled from the unsafe
 * autonomous flag.
 *
 * Before: a job's approved posts only auto-scheduled when
 * `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` was on — the same flag that ALSO
 * auto-approves the publish gate with no human review. With approval-gating ON
 * (the safe prod setting) approved posts stranded (36 stranded IG posts on
 * tenant 15).
 *
 * After: a new flag `ARIES_AUTOSCHEDULE_ON_APPROVAL` (default OFF) makes the
 * publish-completion callback schedule the freshly-synthesized, already-approved
 * posts across both platforms — after a HUMAN approves the publish gate. The
 * guard at the single convergence point (synthesizePublishPostsOnCompletion)
 * becomes `autoApprove || autoScheduleOnApproval`.
 *
 * These tests assert:
 *   - the flag parser matches the existing parser's contract (1/true/yes/on,
 *     case-insensitive, trimmed; default OFF);
 *   - with the new flag ON and auto-approve OFF, a publish completion enters the
 *     auto-schedule path (its `posts` SELECT fires);
 *   - with BOTH flags OFF, the auto-schedule path does not run.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/autoschedule-on-approval.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// --- Flag parser matrix -------------------------------------------------------

test('autoScheduleOnApprovalEnabled: truthy values enable (case/whitespace-insensitive)', async () => {
  const { autoScheduleOnApprovalEnabled } = await import('../../backend/marketing/hermes-callbacks');
  for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON', ' on ', '  1  ', 'TrUe']) {
    assert.equal(
      autoScheduleOnApprovalEnabled({ ARIES_AUTOSCHEDULE_ON_APPROVAL: v } as unknown as NodeJS.ProcessEnv),
      true,
      `expected "${v}" to enable`,
    );
  }
});

test('autoScheduleOnApprovalEnabled: unset / falsy / garbage stays OFF (safe default)', async () => {
  const { autoScheduleOnApprovalEnabled } = await import('../../backend/marketing/hermes-callbacks');
  assert.equal(autoScheduleOnApprovalEnabled({} as unknown as NodeJS.ProcessEnv), false, 'unset → OFF');
  for (const v of ['', '0', 'false', 'no', 'off', 'enabled', 'maybe', '2', 'y']) {
    assert.equal(
      autoScheduleOnApprovalEnabled({ ARIES_AUTOSCHEDULE_ON_APPROVAL: v } as unknown as NodeJS.ProcessEnv),
      false,
      `expected "${v}" to stay OFF`,
    );
  }
});

test('autoScheduleOnApprovalEnabled is independent of ARIES_AUTO_APPROVE_MARKETING_PIPELINE', async () => {
  const { autoScheduleOnApprovalEnabled, autoApproveMarketingPipelineEnabled } =
    await import('../../backend/marketing/hermes-callbacks');
  // The whole point of Piece A: scheduling on approval WITHOUT auto-approving
  // the gate. The two flags must not bleed into each other.
  const env = { ARIES_AUTOSCHEDULE_ON_APPROVAL: '1' } as unknown as NodeJS.ProcessEnv;
  assert.equal(autoScheduleOnApprovalEnabled(env), true);
  assert.equal(autoApproveMarketingPipelineEnabled(env), false);
});

// --- Guard wiring: publish completion → auto-schedule path --------------------

/**
 * Drive a real publish-stage completion callback through handleHermesRunCallback
 * with a mocked pool, and return the SQL strings issued. `flagValue` sets
 * ARIES_AUTOSCHEDULE_ON_APPROVAL; auto-approve is forced OFF so we prove the new
 * flag (not the legacy one) is what opens the gate.
 */
async function runPublishCompletion(flagValue: string | undefined): Promise<string[]> {
  const prev: Record<string, string | undefined> = {
    DATA_ROOT: process.env.DATA_ROOT,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ARIES_AUTO_APPROVE_MARKETING_PIPELINE: process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE,
    ARIES_AUTOSCHEDULE_ON_APPROVAL: process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL,
  };
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-autosched-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '0';
  if (flagValue === undefined) delete process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL;
  else process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL = flagValue;

  const sqls: string[] = [];
  let restorePool: (() => void) | null = null;
  try {
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } =
      await import('../../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const poolMod = await import('../../lib/db');
    const pool = poolMod.default;

    const origQuery = pool.query.bind(pool);
    restorePool = () => {
      (pool as { query: typeof origQuery }).query = origQuery;
    };
    (pool as { query: unknown }).query = async (sql: unknown) => {
      sqls.push(String(sql));
      return { rows: [{ id: 1 }], rowCount: 1 } as never;
    };

    const doc = createSocialContentJobRuntimeDocument({
      jobId: `mkt_autosched_${flagValue ?? 'off'}_${dataRoot.slice(-6)}`,
      tenantId: '999',
      payload: { brandUrl: 'https://brand.example', businessType: 'coaching', competitorUrl: '', imageCreativeCount: 1 },
      brandKit: {
        path: '/tmp/brand-kit.json', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
        brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [], external_links: [], extracted_at: new Date().toISOString(), brand_voice_summary: 'clear',
        offer_summary: null, positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes', domain: 'marketing', workflowKey: 'social_content_weekly', action: 'resume',
      tenantId: doc.tenant_id, marketingJobId: doc.job_id, stage: 'publish',
    });

    await handleHermesRunCallback({
      event_id: `evt-autosched-${flagValue ?? 'off'}`,
      aries_run_id: run.aries_run_id,
      hermes_run_id: `hermes-autosched-${flagValue ?? 'off'}`,
      status: 'completed',
      stage: 'publish',
      output: [
        {
          stage: 'publish',
          // Non-empty schedule[] so readWeeklySchedule passes and the
          // auto-schedule path reaches its `posts` SELECT.
          schedule: [{ post_number: 1, recommended_day: 'Monday', platform: 'instagram' }],
        },
      ],
    });
  } finally {
    if (restorePool) restorePool();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
  return sqls;
}

// The auto-schedule entry query is distinctive: it selects idempotency_key
// (with surface/media_type) from posts. Matching it proves the guard let us into
// autoScheduleApprovedPostsForJob — i.e. the publish-stage + approved invariant
// is structurally satisfied and the new flag opened the gate.
const AUTO_SCHEDULE_POSTS_SELECT = /select[\s\S]*idempotency_key[\s\S]*from\s+posts/i;

test('flag ON + auto-approve OFF → publish completion enters the auto-schedule path', async () => {
  const sqls = await runPublishCompletion('1');
  const fired = sqls.some((s) => AUTO_SCHEDULE_POSTS_SELECT.test(s));
  assert.ok(
    fired,
    `ARIES_AUTOSCHEDULE_ON_APPROVAL=1 must reach the auto-schedule posts SELECT. SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')}`,
  );
});

test('both flags OFF → auto-schedule path does not run', async () => {
  const sqls = await runPublishCompletion(undefined);
  const fired = sqls.some((s) => AUTO_SCHEDULE_POSTS_SELECT.test(s));
  assert.equal(
    fired,
    false,
    `with both flags OFF the auto-schedule posts SELECT must NOT fire. SQLs: ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')}`,
  );
});
