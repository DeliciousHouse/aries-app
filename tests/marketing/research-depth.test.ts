/**
 * "Make research real" (audit item 3).
 *
 * Three things are pinned here, because each of them fails SILENTLY:
 *
 *  1. The 28-day performance block reaches the RESEARCH submission, not only
 *     the two-line `recent_performance` inside Request (JSON). If item 1's
 *     preload ever narrows back to strategy-only, or the render guard keys off
 *     the wrong stage value, the headline feature of this item simply stops
 *     appearing — no error, no failing type, no changed status.
 *  2. The mandatory `/last30days` + `performance_signals` mandate lives on the
 *     WEEKLY research builder only. The shared RESEARCH_TOOL_POLICY is also
 *     served to the brand-campaign (`marketing_pipeline`) path on the DEFAULT
 *     8642 gateway, whose profile is not known to carry the last30days skill
 *     and never receives a performance block. Making the mandate shared would
 *     point that agent at a skill it may not have and a block that never
 *     exists for it.
 *  3. The gateway URL/key pairing guard. A blank URL stays on the shared
 *     gateway even if a stale dedicated key remains; a dedicated URL with no
 *     matching key is rejected loudly instead of failing silently.
 *
 * Fully in-memory: recording fetchImpl, noop brand-kit refresher, noop callback
 * token client, and a fake perf queryable injected as the 6th constructor arg
 * (item 1 made the loader constructor-injectable — no Postgres in this suite).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HermesMarketingPort,
  buildHermesInstructions,
  buildHermesStageInstructions,
  describeProfileGatewayKeyFallback,
} from '../../backend/marketing/ports/hermes';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../../backend/social-content/defaults';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';
import type { PerformanceContextQueryable } from '../../backend/marketing/performance-context';

const TENANT_ID = '42';
/** The literal BLOCK_HEADER emitted by backend/marketing/performance-context.ts. */
const PERF_HEADER = 'Last 28 days performance';
/** The research-only framing line added by this item. */
const RESEARCH_PREAMBLE_MARKER = 'Tenant performance summary';

/**
 * No per-profile gateway vars: this base env must be coherent so that the
 * misconfiguration warning fires only in the test that asks for it.
 */
const ENV = {
  HERMES_GATEWAY_URL: 'http://127.0.0.1:8642',
  HERMES_API_SERVER_KEY: 'default-key',
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
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-research-depth-'));
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
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research', 'not_started', null),
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

function promptOf(call: FetchCall): string {
  const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
  return String(body.input ?? '');
}

function instructionsOf(call: FetchCall): string {
  const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
  return String(body.instructions ?? '');
}

/** Capture console.warn for the duration of `run`. */
async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const previous = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = previous;
  }
}

// ── 1. The full block reaches the research submission ──────────────────────

test('the research submission carries the FULL performance block, not just the condensed line', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_perf');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    assert.equal(calls.length, 1);
    const prompt = promptOf(calls[0]);
    assert.ok(prompt.includes(RESEARCH_PREAMBLE_MARKER), 'research-only framing line present');
    assert.ok(prompt.includes(PERF_HEADER), 'full 28-day block present');
    assert.ok(prompt.includes('WINNER HOOK'), 'the winning caption reaches the researcher');
    assert.ok(prompt.includes('LOSER HOOK'), 'the weakest caption reaches the researcher');
    assert.ok(prompt.includes('instagram 4,812'), 'the follower trend reaches the researcher');
    assert.equal(dbCalls.length, 2, 'exactly the two perf queries — no extra SQL added by this item');

    // Ordering: the block is appended AFTER the serialized request, so the
    // single-line `Request (JSON):` parse every other consumer relies on is
    // untouched.
    assert.ok(
      prompt.indexOf('Request (JSON): ') < prompt.indexOf(RESEARCH_PREAMBLE_MARKER),
      'the block must follow Request (JSON), never split it',
    );
    const marker = 'Request (JSON): ';
    const json = prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0];
    const request = JSON.parse(json) as { input: { recent_performance?: string } };
    assert.ok(request.input.recent_performance, 'item 1 condensed line still rides the request JSON');
  });
});

test('the research submission ships the widened budget and the performance_signals mandate', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_instructions');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable);

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    const instructions = instructionsOf(calls[0]);
    assert.ok(instructions.includes('12 total tool calls'), 'the widened budget must be on the wire');
    assert.ok(instructions.includes('performance_signals'), 'the tie-back mandate must be on the wire');
  });
});

test('the research prompt with the flag off is byte-identical to having no insights rows', async () => {
  const run = async (envOverrides: Record<string, string>, empty: boolean) => withDataRoot(async () => {
    const doc = weeklyDoc('job_research_off');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable, calls: dbCalls } = makePerfDb({ empty });
    const port = makePort(fetchImpl, queryable, envOverrides);
    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
    return { prompt: promptOf(calls[0]), dbCalls: dbCalls.length };
  });

  const off = await run({ ARIES_PERF_CONTEXT_ENABLED: '0' }, false);
  const noRows = await run({}, true);

  assert.equal(off.prompt.includes(PERF_HEADER), false, 'flag off means no block');
  assert.equal(off.prompt.includes(RESEARCH_PREAMBLE_MARKER), false, 'flag off means no framing line either');
  assert.equal(off.dbCalls, 0, 'flag off issues zero queries');
  assert.equal(noRows.prompt.includes(RESEARCH_PREAMBLE_MARKER), false, 'no rows means no framing line');
  const normalize = (p: string) => p
    .replace(/^Aries run ID: .*$/m, 'Aries run ID: <id>')
    .replace(/"aries_run_id":"[^"]*"/g, '"aries_run_id":"<id>"');
  assert.equal(
    normalize(off.prompt),
    normalize(noRows.prompt),
    'flag-off prompt matches the no-data prompt exactly',
  );
});

test('a failing perf query never blocks the research submission', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_dbdown');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb({ fail: true });
    const port = makePort(fetchImpl, queryable);

    const result = await port.runPipeline({
      jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000,
    });

    assert.equal(result.kind, 'submitted', 'an insights outage must not stop a weekly run');
    assert.equal(calls.length, 1);
    const prompt = promptOf(calls[0]);
    assert.equal(prompt.includes(RESEARCH_PREAMBLE_MARKER), false, 'no half-built block on failure');
    assert.ok(prompt.includes('Request (JSON): '), 'the rest of the prompt is intact');
  });
});

test('a regenerate-creative run is research-shaped but gets no performance block', async () => {
  // runPipeline() hardcodes the research stage, so a single-creative
  // regenerate/image-edit run reaches the same render site. It carries its own
  // per-image scope and must not be handed a week-wide block.
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_regen');
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

    assert.equal(dbCalls.length, 0, 'a regenerate must not pay for an insights read');
    assert.equal(promptOf(calls[0]).includes(RESEARCH_PREAMBLE_MARKER), false);
    assert.equal(promptOf(calls[0]).includes(PERF_HEADER), false);
  });
});

// ── 2. The mandate is weekly-only; the shared policy stays permissive ──────

test('weekly research instructions make /last30days REQUIRED and demand performance_signals', () => {
  const instructions = buildHermesStageInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, 'research');
  assert.ok(instructions.includes('12 total tool calls'), 'budget raised to 12');
  assert.ok(instructions.includes('mandatory here, not optional'), 'the weekly mandate must be present');
  assert.ok(instructions.includes('/last30days'), 'still referenced as a slash command');
  assert.ok(instructions.includes('performance_signals'), 'research must tie findings back to measured posts');
  assert.ok(
    instructions.includes(PERF_HEADER),
    'the directive must name the block by the literal header performance-context.ts emits',
  );
  // Regression guards inherited from tests/marketing/build-hermes-instructions.test.ts:
  // last30days was once reframed as a terminal command and images stopped rendering.
  assert.ok(!instructions.includes('run last30days via terminal'));
  assert.ok(!instructions.includes('last30days command'));
});

test('the shared tool policy keeps /last30days OPTIONAL for the default-gateway path', () => {
  // buildHermesInstructions serves the brand-campaign (marketing_pipeline)
  // workflow on the DEFAULT 8642 gateway. That profile is not known to carry
  // the last30days skill, and it never receives a performance block — a
  // REQUIRED step it cannot perform would turn a skipped enrichment into a
  // stage failure, and a directive about a block that never arrives is noise.
  //
  // NOTE: buildHermesInstructions(WEEKLY) delegates to the weekly research
  // builder, so only the non-weekly key exercises the combined set. Both
  // routes to the brand-campaign path are checked.
  for (const key of ['marketing_pipeline', 'some_other_workflow']) {
    const instructions = buildHermesInstructions(key);
    assert.ok(instructions.includes('12 total tool calls'), `${key}: budget is shared`);
    assert.ok(instructions.includes('optionally invoke `/last30days`'), `${key}: step (4) stays permissive`);
    assert.ok(
      !instructions.includes('mandatory here, not optional'),
      `${key}: the weekly-only mandate must not leak into the combined instruction set`,
    );
    assert.ok(
      !instructions.includes('performance_signals'),
      `${key}: no performance block is ever injected on this path`,
    );
    assert.equal(
      instructions,
      buildHermesStageInstructions(key, 'research'),
      `${key}: the non-weekly stage router must still hand back the combined set`,
    );
  }
});

test('the shared policy references the performance block conditionally, never as a given', () => {
  const instructions = buildHermesInstructions('marketing_pipeline');
  const idx = instructions.indexOf(PERF_HEADER);
  assert.ok(idx > 0, 'step (5) does mention the block…');
  assert.ok(
    instructions.slice(Math.max(0, idx - 60), idx).includes('when the input carries'),
    '…but only behind a "when the input carries" condition',
  );
});

// ── 3. The compose-default gateway footgun ────────────────────────────────

test('a blank or unset research gateway URL reaches the shared-gateway rollback', async () => {
  const compose = await readFile(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
  assert.match(
    compose,
    /HERMES_RESEARCH_GATEWAY_URL:\s*\$\{HERMES_RESEARCH_GATEWAY_URL:-\}/,
    'Compose must leave the profile URL empty until an operator explicitly configures it',
  );
  assert.doesNotMatch(
    compose,
    /HERMES_RESEARCH_GATEWAY_URL:\s*\$\{HERMES_RESEARCH_GATEWAY_URL:-http:\/\/host\.docker\.internal:8651\}/,
    'defaulting blank or unset to 8651 makes the documented rollback unsafe',
  );
});

test('the shared-gateway rollback ignores a stale dedicated research key', async () => {
  await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_shared_gateway');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable, {
      HERMES_RESEARCH_GATEWAY_URL: '',
      HERMES_RESEARCH_API_SERVER_KEY: 'stale-research-key',
    });

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    assert.equal(calls[0]?.url, `${ENV.HERMES_GATEWAY_URL}/v1/runs`);
    assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), 'Bearer default-key');
    assert.equal(
      instructionsOf(calls[0]).includes('mandatory here, not optional'),
      false,
      'the shared profile may not have last30days, so rollback instructions must keep it optional',
    );
  });
});

test('describeProfileGatewayKeyFallback flags a repointed URL with no per-profile key', () => {
  const warning = describeProfileGatewayKeyFallback('aries-research', {
    HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
    HERMES_API_SERVER_KEY: 'default-key',
    HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
    HERMES_RESEARCH_API_SERVER_KEY: '',
  });
  assert.ok(warning, 'the exact compose-default-without-key state must warn');
  assert.ok(warning.includes('HERMES_RESEARCH_GATEWAY_URL'), 'names the URL var');
  assert.ok(warning.includes('HERMES_RESEARCH_API_SERVER_KEY'), 'names the key var');
  assert.ok(warning.includes('HERMES_API_SERVER_KEY'), 'names the var actually being used');
  assert.ok(warning.includes('401'), 'names the failure the operator will see');
  assert.ok(warning.includes('GATEWAY AUTH MISCONFIGURED'), 'greppable marker');
});

test('describeProfileGatewayKeyFallback stays silent on every coherent configuration', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['single-gateway deployment (no per-profile vars)', {
      HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
      HERMES_API_SERVER_KEY: 'default-key',
    }],
    ['URL and key both set', {
      HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
      HERMES_API_SERVER_KEY: 'default-key',
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
      HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
    }],
    // Pinning the same gateway explicitly is a legitimate, common config: the
    // shared key IS the right key there, so warning would be a false positive
    // that teaches operators to ignore the line.
    ['per-profile URL that is the default gateway (trailing slash and all)', {
      HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
      HERMES_API_SERVER_KEY: 'default-key',
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8642/',
    }],
  ];
  for (const [label, env] of cases) {
    assert.equal(describeProfileGatewayKeyFallback('aries-research', env), null, label);
  }
});

test('the misconfiguration warning actually fires on a real research submission', async () => {
  const { warnings } = await captureWarnings(async () => withDataRoot(async () => {
    const doc = weeklyDoc('job_research_misconfig');
    const { fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable, {
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
    });
    return port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
  }));

  assert.ok(
    warnings.some((w) => w.includes('GATEWAY AUTH MISCONFIGURED') && w.includes('aries-research')),
    `expected a gateway-auth warning at submission time, got: ${JSON.stringify(warnings)}`,
  );
});

test('a coherent gateway pair submits without any auth warning', async () => {
  const { result: calls, warnings } = await captureWarnings(async () => withDataRoot(async () => {
    const doc = weeklyDoc('job_research_ok');
    const { calls, fetchImpl } = recordingFetch();
    const { queryable } = makePerfDb();
    const port = makePort(fetchImpl, queryable, {
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
      HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
    });
    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
    return calls;
  }));

  assert.equal(
    warnings.filter((w) => w.includes('GATEWAY AUTH MISCONFIGURED')).length,
    0,
    'no false positive when the pair is set together',
  );
  assert.ok(
    instructionsOf(calls[0]).includes('mandatory here, not optional'),
    'the dedicated research profile keeps the last30days mandate',
  );
});

/**
 * ops/aries-pipeline-monitor.py demotes any last_error matching these to
 * digest-only ("covered by hermes-auth-sentinel"). The sentinel owns provider
 * OAuth grants and knows nothing about per-profile gateway keys, so a
 * misconfigured-key 401 MUST NOT match — otherwise the failure that kills the
 * whole weekly pipeline at stage 1 is the one failure nobody is paged for.
 * Kept in sync by hand with AUTH_SIGNATURE in that file.
 */
const MONITOR_AUTH_SIGNATURE =
  /provider authentication failed|token refresh failed|could not validate your refresh token|re-?authenticate|\bHTTP 401\b|\b401 unauthorized\b/i;

function rejectingFetch(status: number) {
  return async (): Promise<Response> => new Response('{"error":"unauthorized"}', {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorOf(result: Awaited<ReturnType<HermesMarketingPort['runPipeline']>>) {
  const output = (result as { output?: { error?: { code?: string; message?: string } } }).output;
  return output?.error ?? {};
}

test('a 401 from a repointed gateway with no per-profile key fails with its own code, invisible to the monitor suppression', async () => {
  const result = await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_401_misconfig');
    const { queryable } = makePerfDb();
    const port = makePort(rejectingFetch(401), queryable, {
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
    });
    return port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
  });

  const error = errorOf(result);
  assert.equal(error.code, 'hermes_gateway_key_misconfigured');
  const message = String(error.message ?? '');
  assert.ok(
    message.includes('HERMES_RESEARCH_API_SERVER_KEY'),
    `names the var the operator must set, got: ${message}`,
  );
  assert.ok(
    !MONITOR_AUTH_SIGNATURE.test(message) && !MONITOR_AUTH_SIGNATURE.test(String(error.code)),
    `must not match the monitor's provider-auth suppression, got: ${message}`,
  );
});

test('a 401 on a coherent gateway pair keeps the generic (sentinel-owned) failure', async () => {
  const result = await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_401_coherent');
    const { queryable } = makePerfDb();
    const port = makePort(rejectingFetch(401), queryable, {
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
      HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
    });
    return port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
  });

  const error = errorOf(result);
  assert.equal(error.code, 'hermes_gateway_request_failed');
  assert.match(String(error.message ?? ''), /HTTP 401/);
});

test('a non-401 rejection on a misconfigured pair keeps the generic failure', async () => {
  const result = await withDataRoot(async () => {
    const doc = weeklyDoc('job_research_500_misconfig');
    const { queryable } = makePerfDb();
    const port = makePort(rejectingFetch(500), queryable, {
      HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8651',
    });
    return port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });
  });

  assert.equal(errorOf(result).code, 'hermes_gateway_request_failed');
});
