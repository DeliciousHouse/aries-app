/**
 * Port-level wiring for the weekly performance context.
 *
 * The formatter itself is covered by tests/marketing/performance-context.test.ts;
 * this file pins WHERE the block lands on the wire:
 *   - the STRATEGY submission (both the approval-resume→run conversion and the
 *     auto-advance action:'run' path — autonomous mode reaches strategy through
 *     whichever one the job's approval config selects),
 *   - the weekly research request, as the 2-line `input.recent_performance`,
 * and where it must NOT land (production/publish auto-advance, flag off).
 *
 * Fully in-memory: recording fetchImpl, noop brand-kit refresher, noop callback
 * token client, and a fake perf queryable injected as the 6th constructor arg.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../../backend/marketing/ports/hermes';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../../backend/social-content/defaults';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';
import type { PerformanceContextQueryable } from '../../backend/marketing/performance-context';

const TENANT_ID = '42';
const PERF_HEADER = 'Last 28 days performance';
const PERF_INSTRUCTION = 'Instruction: exploit what worked';

const ENV = {
  HERMES_GATEWAY_URL: 'http://127.0.0.1:8642',
  HERMES_API_SERVER_KEY: 'default-key',
  HERMES_STRATEGY_GATEWAY_URL: 'http://127.0.0.1:8651',
  HERMES_STRATEGY_API_SERVER_KEY: 'strategy-key',
  HERMES_CONTENT_GATEWAY_URL: 'http://127.0.0.1:8655',
  HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_POLL_BRIDGE_ENABLED: '0',
};

type FetchCall = { url: string; init: RequestInit };

function recordingFetch() {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ run_id: 'hermes-run-1', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const NO_SLEEP = async () => {};
const NO_OP_BRAND_KIT_REFRESHER = async () => ({ refreshed: false, enriched: false });
const NO_OP_CALLBACK_TOKEN_CLIENT = {
  async query() {
    return { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
  },
};

/** Six measured posts + a 4-week follower trend, routed by SQL shape. */
function makePerfDb(options: { fail?: boolean; empty?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const posts = [
    { platform: 'instagram', media_type: 'reel', content_type: null, caption: 'WINNER HOOK', permalink: null, published_at: '2026-07-28T10:00:00.000Z', engagement: 412, likes: 391, comments: 18, shares: 3, reach: null, rn_top: 1, rn_bottom: 21, total_posts: 21 },
    { platform: 'instagram', media_type: 'reel', content_type: null, caption: 'second', permalink: null, published_at: '2026-07-26T10:00:00.000Z', engagement: 300, likes: 280, comments: 15, shares: 5, reach: null, rn_top: 2, rn_bottom: 20, total_posts: 21 },
    { platform: 'instagram', media_type: 'image', content_type: null, caption: 'third', permalink: null, published_at: '2026-07-24T10:00:00.000Z', engagement: 250, likes: 240, comments: 8, shares: 2, reach: null, rn_top: 3, rn_bottom: 19, total_posts: 21 },
    { platform: 'facebook', media_type: 'image', content_type: null, caption: 'LOSER HOOK', permalink: null, published_at: '2026-08-02T10:00:00.000Z', engagement: 6, likes: 5, comments: 1, shares: 0, reach: null, rn_top: 21, rn_bottom: 1, total_posts: 21 },
    { platform: 'facebook', media_type: 'image', content_type: null, caption: 'weak two', permalink: null, published_at: '2026-08-01T10:00:00.000Z', engagement: 12, likes: 11, comments: 1, shares: 0, reach: null, rn_top: 20, rn_bottom: 2, total_posts: 21 },
    { platform: 'facebook', media_type: 'image', content_type: null, caption: 'weak three', permalink: null, published_at: '2026-07-31T10:00:00.000Z', engagement: 20, likes: 18, comments: 2, shares: 0, reach: null, rn_top: 19, rn_bottom: 3, total_posts: 21 },
  ];
  const followers = [
    { platform: 'instagram', week_start: '2026-07-13', followers_delta: 21, followers_end: 4795 },
    { platform: 'instagram', week_start: '2026-07-20', followers_delta: 4, followers_end: 4799 },
    { platform: 'instagram', week_start: '2026-07-27', followers_delta: -2, followers_end: 4797 },
    { platform: 'instagram', week_start: '2026-08-03', followers_delta: 15, followers_end: 4812 },
  ];
  const queryable: PerformanceContextQueryable = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (options.fail) throw new Error('perf db down');
      if (options.empty) return { rows: [], rowCount: 0 };
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('WITH per_post')) return { rows: posts, rowCount: posts.length };
      if (norm.startsWith('WITH windowed')) return { rows: followers, rowCount: followers.length };
      return { rows: [], rowCount: 0 };
    },
  };
  return { queryable, calls };
}

function makePort(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  perfQueryable: PerformanceContextQueryable,
  envOverrides: Record<string, string> = {},
) {
  return new HermesMarketingPort(
    { ...ENV, ...envOverrides },
    fetchImpl,
    NO_SLEEP,
    NO_OP_BRAND_KIT_REFRESHER,
    NO_OP_CALLBACK_TOKEN_CLIENT,
    perfQueryable,
  );
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-perf-injection-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function weeklyDoc(jobId: string): SocialContentJobRuntimeDocument {
  const ts = new Date().toISOString();
  const stageRecord = (stage: string, status: string, primaryOutput: Record<string, unknown> | null) => ({
    stage,
    status,
    started_at: ts,
    completed_at: status === 'completed' ? ts : null,
    failed_at: null,
    run_id: `run-${stage}`,
    summary: null,
    primary_output: primaryOutput,
    outputs: {},
    artifacts: [],
    errors: [],
  });
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: TENANT_ID,
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'strategy',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research', 'completed', { positioning: 'RESEARCH_MARKER' }),
      strategy: stageRecord('strategy', 'not_started', null),
      production: stageRecord('production', 'not_started', null),
      publish: stageRecord('publish', 'not_started', null),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      brand_name: 'Aries AI',
      brand_voice_summary: 'Calm, premium, systemized.',
      offer_summary: 'A weekly content operating system.',
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      colors: { primary: '#d8475f', secondary: null, accent: null, palette: [], background: null, mode: null },
      logo_urls: [],
      font_families: [],
      external_links: [],
      extracted_at: ts,
      source_url: 'https://brand.example/',
      canonical_url: 'https://brand.example/',
    },
    inputs: {
      brand_url: 'https://brand.example/',
      request: { jobType: 'weekly_social_content', channels: ['instagram', 'meta'], windowDays: 7, staticPostCount: 7 },
    },
    created_at: ts,
    updated_at: ts,
    history: [],
  } as unknown as SocialContentJobRuntimeDocument;
}

async function saveDoc(doc: SocialContentJobRuntimeDocument) {
  const { saveSocialContentJobRuntime } = await import('../../backend/marketing/runtime-state');
  saveSocialContentJobRuntime(doc.job_id, doc);
}

function promptOf(call: FetchCall): string {
  const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
  return String(body.input ?? '');
}

// ── Strategy submission: the approval-resume → run conversion ───────────────

test('weekly strategy resume: the performance block lands beside the prior stage output', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_resume');
    await saveDoc(doc);
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.resumePipeline({
      jobId: doc.job_id,
      tenantId: TENANT_ID,
      workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      stage: 'strategy',
      resumeToken: 'tok-1',
      approve: true,
    });

    assert.equal(calls.length, 1);
    const prompt = promptOf(calls[0]);
    assert.ok(prompt.includes('Prior stage output (JSON)'), 'the prior stage output still leads');
    assert.ok(prompt.includes(PERF_HEADER), 'performance block injected');
    assert.ok(prompt.includes(PERF_INSTRUCTION), 'exploit/vary instruction present');
    assert.ok(prompt.includes('WINNER HOOK'), 'the winning caption reaches the strategist');
    assert.ok(prompt.includes('LOSER HOOK'), 'the weakest caption reaches the strategist');
    assert.ok(prompt.includes('instagram 4,812'), 'follower trend present');
    assert.equal(dbCalls.length, 2, 'exactly the two perf queries');
  });
});

test('weekly resume with NO stage still gets the block (submissionPayload defaults to strategy)', async () => {
  // resumeStageFromInput returns undefined when neither an explicit stage nor
  // an approval step is supplied (token-only resume), while submissionPayload
  // defaults that same submission to `stage: 'strategy'`. If the gate keyed off
  // the raw effectiveStage, this path would submit a strategy run with the
  // block silently missing.
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_resume_nostage');
    await saveDoc(doc);
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.resumePipeline({
      jobId: doc.job_id,
      tenantId: TENANT_ID,
      workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      resumeToken: 'tok-2',
      approve: true,
    });

    assert.equal(calls.length, 1);
    const prompt = promptOf(calls[0]);
    assert.ok(prompt.includes('Stage: strategy'), 'this submission really is a strategy run');
    assert.ok(prompt.includes(PERF_HEADER), 'performance block injected on the stage-less resume');
    assert.ok(prompt.includes(PERF_INSTRUCTION));
  });
});

test('weekly strategy resume with the flag off is byte-identical to having no insights rows', async () => {
  const run = async (envOverrides: Record<string, string>, empty: boolean) => withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_resume_off');
    await saveDoc(doc);
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb({ empty });
    const port = makePort(fetchImpl, queryable, envOverrides);
    await port.resumePipeline({
      jobId: doc.job_id,
      tenantId: TENANT_ID,
      workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      stage: 'strategy',
      resumeToken: 'tok-3',
      approve: true,
    });
    return { prompt: promptOf(calls[0]), dbCalls: dbCalls.length };
  });

  const off = await run({ ARIES_PERF_CONTEXT_ENABLED: '0' }, false);
  const noRows = await run({}, true);

  assert.equal(off.prompt.includes(PERF_HEADER), false, 'flag off means no block');
  assert.equal(off.dbCalls, 0, 'flag off issues zero queries');
  assert.equal(noRows.prompt.includes(PERF_HEADER), false, 'no insights rows means no block');
  // The run id is freshly generated per submission; everything else must match.
  const normalize = (p: string) => p.replace(/^Aries run ID: .*$/m, 'Aries run ID: <id>');
  assert.equal(
    normalize(off.prompt),
    normalize(noRows.prompt),
    'flag-off prompt matches the no-data prompt exactly',
  );
});

// ── Strategy submission: the auto-advance action:'run' path ────────────────

test('auto-advanced strategy run carries the same performance block', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.submitNextStage({
      jobId: 'job_perf_autoadvance',
      tenantId: TENANT_ID,
      doc: weeklyDoc('job_perf_autoadvance'),
      stage: 'strategy',
    });

    const prompt = promptOf(calls[0]);
    assert.ok(prompt.includes(PERF_HEADER), 'auto-advance strategy gets the block too');
    assert.ok(prompt.includes(PERF_INSTRUCTION));
  });
});

test('auto-advanced production run issues no perf query and carries no performance text', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.submitNextStage({
      jobId: 'job_perf_production',
      tenantId: TENANT_ID,
      doc: weeklyDoc('job_perf_production'),
      stage: 'production',
    });

    assert.equal(dbCalls.length, 0, 'production must not pay for a perf read');
    assert.equal(promptOf(calls[0]).includes(PERF_HEADER), false);
  });
});

// ── Weekly research request: the condensed line ────────────────────────────

test('research run carries a two-line recent_performance in the weekly request', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_research');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    const prompt = promptOf(calls[0]);
    const marker = 'Request (JSON): ';
    const json = prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0];
    const request = JSON.parse(json) as { input: { recent_performance?: string } };
    const summary = request.input.recent_performance;
    assert.ok(summary, 'recent_performance present on the research request');
    assert.equal(summary.split('\n').length, 2, 'exactly two lines');
    assert.match(summary, /Recent performance \(28d, 21 measured posts\)/);
    assert.match(summary, /Lean into what worked; vary what did not\./);
  });
});

test('research run with the flag off omits recent_performance entirely', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_research_off');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb();
    const port = makePort(fetchImpl, queryable, { ARIES_PERF_CONTEXT_ENABLED: '0' });

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    const prompt = promptOf(calls[0]);
    const marker = 'Request (JSON): ';
    const json = prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0];
    const request = JSON.parse(json) as { input: Record<string, unknown> };
    assert.equal('recent_performance' in request.input, false, 'field absent, not null/empty');
    assert.equal(dbCalls.length, 0);
  });
});

test('a regenerate-creative run keeps its byte-identical request and pays for no perf read', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_regen');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.runPipeline({
      jobId: doc.job_id,
      doc,
      argsJson: '{}',
      timeoutMs: 5000,
      maxStdoutBytes: 1000,
      regenerateCreative: { source_run_id: 'arun_src', source_creative_id: 'creative-1' },
    });

    assert.equal(dbCalls.length, 0, 'a single-creative regenerate must not query insights');
    const prompt = promptOf(calls[0]);
    const marker = 'Request (JSON): ';
    const json = prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0];
    const request = JSON.parse(json) as { input: Record<string, unknown> };
    assert.equal('recent_performance' in request.input, false);
    assert.equal(prompt.includes(PERF_HEADER), false);
  });
});

// ── Fail-open ──────────────────────────────────────────────────────────────

test('a failing perf query never blocks the strategy submission', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_perf_dbdown');
    await saveDoc(doc);
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb({ fail: true });
    const port = makePort(fetchImpl, queryable);

    const result = await port.resumePipeline({
      jobId: doc.job_id,
      tenantId: TENANT_ID,
      workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      stage: 'strategy',
      resumeToken: 'tok-4',
      approve: true,
    });

    assert.equal(result.kind, 'submitted', 'submission still happens');
    assert.equal(calls.length, 1);
    const prompt = promptOf(calls[0]);
    assert.equal(prompt.includes(PERF_HEADER), false, 'no half-built block on failure');
    assert.ok(prompt.includes('Prior stage output (JSON)'), 'the rest of the prompt is intact');
  });
});
