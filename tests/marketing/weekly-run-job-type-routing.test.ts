/**
 * AA-235 / DEFECT A — a scheduled weekly run must reach Hermes carrying its
 * inputs.
 *
 * INCIDENT. `usesPerStageProfilePipeline()` decides whether an `action:'run'`
 * submission takes the weekly per-stage branch (brand kit + scope + objective +
 * prior-stage artifacts, via `buildSocialContentWeeklyRequest`) or the generic
 * brand-campaign branch, whose run prompt is five lines of bare identifiers. It
 * reads `doc.inputs.request.jobType`. But `startSocialContentJob` receives
 * `jobType` as a SIBLING of `payload`, and `runtime-state.ts` persists
 * `request: input.payload` verbatim — so unless the caller ALSO duplicated
 * jobType inside the payload (only `app/api/marketing/jobs/handler.ts` did),
 * the field is simply absent. Every scheduled weekly run therefore submitted an
 * identifier-only prompt; the agent refused for lack of inputs, and on
 * 2026-08-12 that refusal prose was synthesized into `posts.caption`,
 * auto-approved, scheduled and PUBLISHED to live brand accounts.
 *
 * WHY THESE TESTS GO THROUGH `startSocialContentJob`. The pre-existing port
 * tests (e.g. tests/hermes-port-brand-context.test.ts) hand-build the runtime
 * document with `jobType` already inside the payload and never touch the real
 * entry point — which is exactly why they were all green while every weekly job
 * in production took the wrong branch. These tests start a job the way the
 * weekly trigger worker starts one (jobType as a sibling parameter, absent from
 * the payload) and assert on what the real HermesMarketingPort actually PUTS ON
 * THE WIRE.
 *
 * Hermes and the brand site are both intercepted; nothing leaves the process.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// Trailing slash is deliberate: the payload sanitizer round-trips brandUrl
// through `new URL(...).toString()`, so a slash-less form would diverge from
// the raw value the brand-kit extractor is handed and trip the runtime
// document's brand_kit_source_mismatch assertion.
const BRAND_URL = 'https://brand.aa235.example/';

const HERMES_ENV = {
  HERMES_GATEWAY_URL: 'http://hermes.test:8642',
  HERMES_API_SERVER_KEY: 'test-key',
  INTERNAL_API_SECRET: 'test-internal-secret',
  APP_BASE_URL: 'https://aries.test',
  ARIES_TENANT_PSEUDONYM_SALT: 'aa235-routing-test-salt-32chars!!',
  HERMES_POLL_BRIDGE_ENABLED: '0',
  ARIES_PERF_CONTEXT_ENABLED: '0',
  ARIES_HONCHO_BRAND_CONTEXT_ENABLED: '0',
  HONCHO_ENABLED: 'false',
};

type Submission = { url: string; body: Record<string, unknown> };

/** Captures every Hermes submission the port makes. */
function makeHermesFetch() {
  const submissions: Submission[] = [];
  let runs = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    submissions.push({ url: String(url), body: (body ?? {}) as Record<string, unknown> });
    runs += 1;
    return new Response(JSON.stringify({ run_id: `run-${runs}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { submissions, fetchImpl };
}

/**
 * Pre-seed a fresh tenant brand kit so `extractAndSaveTenantBrandKit` returns
 * the cached one and the test never touches the network (the SSRF guard would
 * otherwise resolve DNS for real).
 */
async function seedBrandKit(tenantId: string): Promise<void> {
  const { saveTenantBrandKit } = await import('../../backend/marketing/brand-kit');
  saveTenantBrandKit(tenantId, {
    tenant_id: tenantId,
    source_url: BRAND_URL,
    canonical_url: BRAND_URL,
    brand_name: 'AA235 Brand',
    logo_urls: [`${BRAND_URL}/logo.svg`],
    colors: { primary: '#123456', secondary: null, accent: null, palette: ['#123456'] },
    font_families: ['Manrope'],
    external_links: [],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: 'Hand-made leather goods for city commuters.',
    offer_summary: null,
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  } as never);
}

async function withRuntimeEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-aa235-'));
  const overrides: Record<string, string | undefined> = {
    CODE_ROOT: PROJECT_ROOT,
    DATA_ROOT: dataRoot,
    ARIES_TENANT_PSEUDONYM_SALT: HERMES_ENV.ARIES_TENANT_PSEUDONYM_SALT,
    ...env,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

/**
 * Start a weekly job EXACTLY the way `backend/marketing/weekly-trigger.ts`
 * does — `jobType` as a sibling parameter, deliberately NOT inside `payload` —
 * with the real HermesMarketingPort wired to a capturing fetch.
 */
async function startWeeklyJobThroughRealPort(tenantId: string) {
  await seedBrandKit(tenantId);
  const { submissions, fetchImpl } = makeHermesFetch();
  const orchestrator = await import('../../backend/marketing/orchestrator');
  const { HermesMarketingPort } = await import('../../backend/marketing/ports/hermes');
  const port = new HermesMarketingPort(
    { ...process.env, ...HERMES_ENV },
    fetchImpl,
    async () => {},
    async () => ({ refreshed: false, enriched: false }),
    { async query() { return { rows: [], rowCount: 0 }; } } as never,
  );
  orchestrator.__setMarketingExecutionPortForTests(() => port as never);
  try {
    const result = await orchestrator.startSocialContentJob({
      tenantId,
      jobType: 'weekly_social_content',
      createdBy: 'weekly-trigger-worker',
      // NOTE: no `jobType` key here. That is the whole point — the scheduled
      // weekly trigger does not put one in the payload, and this test must not
      // "fix" the input it is supposed to be exercising.
      payload: {
        brandUrl: BRAND_URL,
        businessType: 'leather goods retail',
      },
    });
    return { result, submissions };
  } finally {
    orchestrator.__setMarketingExecutionPortForTests(null);
  }
}

/**
 * The workflow key a submission actually declares. Read from
 * `callback_context.workflow_key`, which BOTH submission branches always set —
 * the generic brand-campaign branch omits the top-level `workflow_key` field
 * entirely, so reading that alone cannot tell the two branches apart.
 */
function workflowKeyOf(submission: Submission | undefined): string | undefined {
  const ctx = submission?.body?.callback_context as Record<string, unknown> | undefined;
  const key = ctx?.workflow_key;
  return typeof key === 'string' ? key : undefined;
}

function runSubmissions(submissions: Submission[]): Submission[] {
  return submissions.filter((s) => workflowKeyOf(s) !== undefined);
}

// ---------------------------------------------------------------------------

test('AA-235: a weekly job started the way the scheduler starts one submits the WEEKLY workflow (fallback ON)', async () => {
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '1' }, async () => {
    const { submissions } = await startWeeklyJobThroughRealPort('4242');
    const runs = runSubmissions(submissions);
    assert.ok(runs.length > 0, 'expected at least one Hermes submission');

    const first = runs[0];
    // THE REGRESSION. Before the fix this is 'marketing_pipeline' (the generic
    // brand-campaign key) because inputs.request.jobType was undefined.
    assert.equal(
      workflowKeyOf(first),
      'social_content_weekly',
      'weekly run must submit the per-stage weekly workflow, not the generic brand-campaign workflow',
    );

    // ...and the prompt must actually CARRY the run's inputs. The generic
    // branch emits five identifier lines and no structured request at all,
    // which is what the agent refused over.
    const prompt = String(first.body.input ?? '');
    assert.match(prompt, /Request \(JSON\):/, 'weekly run prompt must carry the structured workflow request');
    assert.match(prompt, /AA235 Brand/, 'weekly run prompt must carry the extracted brand kit');
  });
});

test('AA-235: the started job records its own jobType on inputs.request (fallback ON)', async () => {
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '1' }, async () => {
    const { result } = await startWeeklyJobThroughRealPort('4243');
    const { loadSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
    const doc = await loadSocialContentJobRuntime(result.jobId);
    assert.ok(doc, 'expected the runtime document to be persisted');
    const request = doc!.inputs.request as Record<string, unknown>;
    // Root-cause fix: the persisted request is self-describing, so nothing
    // downstream has to infer the job type from a sibling parameter it never saw.
    assert.equal(request.jobType, 'weekly_social_content');
  });
});

test('AA-235: the fallback is a per-tenant rollout gate, not a fleet-wide flip', async () => {
  // Allowlisted tenant → weekly workflow.
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '4244' }, async () => {
    const { submissions } = await startWeeklyJobThroughRealPort('4244');
    assert.equal(workflowKeyOf(runSubmissions(submissions)[0]), 'social_content_weekly');
  });
  // Non-allowlisted tenant → unchanged behaviour.
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '4244' }, async () => {
    const { submissions } = await startWeeklyJobThroughRealPort('4245');
    assert.equal(workflowKeyOf(runSubmissions(submissions)[0]), 'marketing_pipeline');
  });
});

test('AA-235: with the flag unset the submission is byte-for-byte the pre-fix behaviour', async () => {
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: undefined }, async () => {
    const { result, submissions } = await startWeeklyJobThroughRealPort('4246');
    assert.equal(
      workflowKeyOf(runSubmissions(submissions)[0]),
      'marketing_pipeline',
      'default must stay OFF so landing this change alone does not move any traffic',
    );
    const { loadSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
    const doc = await loadSocialContentJobRuntime(result.jobId);
    assert.equal((doc!.inputs.request as Record<string, unknown>).jobType, undefined);
  });
});

test('AA-235: a doc ALREADY on disk without request.jobType self-heals from its top-level job_type', async () => {
  // The 69 weekly documents persisted before this fix carry no
  // `inputs.request.jobType` — they cannot be re-stamped retroactively, and
  // every auto-advance hop (submitNextStage → action:'run') re-reads them. The
  // read-side fallback is what rescues those in-flight jobs; without it this
  // submission still goes out on the generic workflow.
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '1' }, async () => {
    const tenantId = '4248';
    await seedBrandKit(tenantId);
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } = await import(
      '../../backend/marketing/runtime-state'
    );
    const { loadTenantBrandKit, tenantBrandKitPath } = await import('../../backend/marketing/brand-kit');
    const kit = await loadTenantBrandKit(tenantId);
    const { marketingBrandKitReferenceFromTenantBrandKit } = await import('../../backend/marketing/runtime-state');
    const doc = createSocialContentJobRuntimeDocument({
      jobId: 'mkt_aa235_legacy_doc',
      tenantId,
      // Exactly the persisted shape of a weekly-trigger job: no jobType key.
      payload: { brandUrl: BRAND_URL, businessType: 'leather goods retail' },
      brandKit: marketingBrandKitReferenceFromTenantBrandKit(kit!, tenantBrandKitPath(tenantId)),
      createdBy: 'weekly-trigger-worker',
    });
    saveSocialContentJobRuntime(doc.job_id, doc);
    assert.equal((doc.inputs.request as Record<string, unknown>).jobType, undefined);
    assert.equal(doc.job_type, 'weekly_social_content');

    const { submissions, fetchImpl } = makeHermesFetch();
    const { HermesMarketingPort } = await import('../../backend/marketing/ports/hermes');
    const port = new HermesMarketingPort(
      { ...process.env, ...HERMES_ENV },
      fetchImpl,
      async () => {},
      async () => ({ refreshed: false, enriched: false }),
      { async query() { return { rows: [], rowCount: 0 }; } } as never,
    );
    await port.submitNextStage({ jobId: doc.job_id, tenantId, doc, stage: 'production' } as never);

    assert.equal(
      workflowKeyOf(runSubmissions(submissions)[0]),
      'social_content_weekly',
      'an auto-advance hop on a pre-existing weekly doc must still reach the weekly pipeline',
    );
  });
});

test('AA-235: an explicit request.jobType still wins, ungated — legacy brand_campaign stays generic', async () => {
  await withRuntimeEnv({ ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '1' }, async () => {
    const { __usesPerStageProfilePipelineForTests } = await import('../../backend/marketing/ports/hermes');
    const base = {
      job_type: 'weekly_social_content',
      tenant_id: '4247',
      inputs: { request: {} as Record<string, unknown> },
    } as never;

    // A request that explicitly names a NON-per-stage type must keep routing to
    // the generic workflow even with the fallback flag fully ON — otherwise the
    // fallback would silently re-route the 16 legacy brand_campaign documents.
    const legacy = { ...(base as object), inputs: { request: { jobType: 'brand_campaign' } } } as never;
    assert.equal(__usesPerStageProfilePipelineForTests(legacy, { ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED: '1' }), false);

    // And an explicit per-stage type is honoured with the flag OFF, exactly as
    // it is in production today for the one-off reel companion.
    const oneOff = { ...(base as object), job_type: 'one_off_post', inputs: { request: { jobType: 'one_off_post' } } } as never;
    assert.equal(__usesPerStageProfilePipelineForTests(oneOff, {}), true);
  });
});
