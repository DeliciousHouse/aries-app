import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../../backend/marketing/ports/hermes';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

/**
 * Regression: the auto-advanced production run must carry the hard "this brand
 * is DARK" constraint.
 *
 * Root cause (white-published-posts bug): the per-stage profile pipeline
 * advances strategy -> production via submitNextStage (action:'run' ->
 * buildSocialContentWeeklyRequest). The hard dark-background constraint shipped
 * in #553 lived ONLY in buildProductionResumeContext (the action:'resume'
 * path). So an auto-advanced production stage (no approval gate) reached the
 * content-generator profile with no dark instruction, the agent drafted
 * "bright/soft white" visual_prompts, and the rendered images published WHITE.
 *
 * The fix appends the same production context block (constraint + rich per-image
 * prompts) on the action:'run' production submission. These tests pin the wire
 * `input` so the run and resume production submissions stay in lockstep.
 */

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

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-prod-autoadvance-dark-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const ENV = {
  HERMES_GATEWAY_URL: 'http://127.0.0.1:8642',
  HERMES_API_SERVER_KEY: 'default-key',
  HERMES_CONTENT_GATEWAY_URL: 'http://host.docker.internal:8655',
  HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_POLL_BRIDGE_ENABLED: '0',
};

function makePort(fetchImpl: typeof fetch) {
  return new HermesMarketingPort(
    ENV,
    fetchImpl as unknown as (input: string | URL, init?: RequestInit) => Promise<Response>,
    NO_SLEEP,
    NO_OP_BRAND_KIT_REFRESHER,
  );
}

/** A completed-research/strategy weekly doc whose brand theme is configurable. */
function weeklyDoc(mode: 'dark' | 'light' | null): SocialContentJobRuntimeDocument {
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
    job_id: 'job_dark_autoadvance',
    tenant_id: 'tenant_test',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research', 'completed', { positioning: 'RESEARCH_MARKER' }),
      strategy: stageRecord('strategy', 'completed', { strategySummary: 'STRATEGY_MARKER' }),
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
      colors: {
        primary: '#d8475f',
        secondary: '#7c3aed',
        accent: '#a855f7',
        palette: ['#d8475f', '#7c3aed', '#a855f7', '#c084fc'],
        background: mode === 'dark' ? '#050505' : mode === 'light' ? '#ffffff' : null,
        mode,
      },
      logo_urls: [],
      font_families: ['Inter', 'Manrope'],
      external_links: [],
      extracted_at: ts,
      source_url: 'https://aries.sugarandleather.com/',
      canonical_url: 'https://aries.sugarandleather.com/',
    },
    inputs: {
      brand_url: 'https://aries.sugarandleather.com/',
      request: {
        jobType: 'weekly_social_content',
        channels: ['instagram', 'meta'],
        imageCreativeCount: 2,
        windowDays: 7,
        staticPostCount: 7,
      },
    },
    created_at: ts,
    updated_at: ts,
    history: [],
  } as unknown as SocialContentJobRuntimeDocument;
}

test('auto-advanced production run carries the hard DARK constraint + per-image context', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(fetchImpl as unknown as typeof fetch);
    await port.submitNextStage({
      jobId: 'job_dark_autoadvance',
      tenantId: 'tenant_test',
      doc: weeklyDoc('dark'),
      stage: 'production',
    });
    assert.equal(calls.length, 1);
    // production routes to the content-generator gateway (the auto-advance run path)
    assert.equal(calls[0].url, 'http://host.docker.internal:8655/v1/runs');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    const callbackContext = body.callback_context as Record<string, unknown> | undefined;
    assert.equal(callbackContext?.auto_advance, true, 'submitNextStage marks the run auto_advance');
    const input = String(body.input);
    assert.ok(
      input.includes('NON-NEGOTIABLE: this brand is DARK'),
      'production run input must carry the NON-NEGOTIABLE dark directive',
    );
    assert.ok(
      input.includes('#050505'),
      'production run input must name the dark background color',
    );
    assert.ok(
      input.includes('Production context ('),
      'production run input must carry the rich per-image prompt context block',
    );
  });
});

test('auto-advanced production run for a LIGHT brand does NOT emit the dark directive', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(fetchImpl as unknown as typeof fetch);
    await port.submitNextStage({
      jobId: 'job_dark_autoadvance',
      tenantId: 'tenant_test',
      doc: weeklyDoc('light'),
      stage: 'production',
    });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    const input = String(body.input);
    assert.ok(
      !input.includes('NON-NEGOTIABLE: this brand is DARK'),
      'a light brand must not be forced dark',
    );
    // The per-image context block is still injected (it just lacks the dark line).
    assert.ok(input.includes('Production context ('), 'production run still carries the context block');
  });
});

test('auto-advanced NON-production stage does not get the production context block', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(fetchImpl as unknown as typeof fetch);
    await port.submitNextStage({
      jobId: 'job_dark_autoadvance',
      tenantId: 'tenant_test',
      doc: weeklyDoc('dark'),
      stage: 'strategy',
    });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    const input = String(body.input);
    assert.ok(
      !input.includes('Production context ('),
      'only the production stage should inject the production context block',
    );
    assert.ok(
      !input.includes('NON-NEGOTIABLE: this brand is DARK'),
      'the strategy stage must not carry the production-only dark directive',
    );
  });
});
