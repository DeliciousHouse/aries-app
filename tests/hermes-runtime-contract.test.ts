import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHermesSocialContentRuntimeConfigured,
  probeHermesGatewayCapabilities,
  probeHermesSocialContentRuntime,
} from '../backend/marketing/hermes-runtime-contract';
import { buildHermesInstructions } from '../backend/marketing/ports/hermes';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../backend/social-content/defaults';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION } from '../backend/social-content/defaults';

const BASE_ENV = {
  HERMES_GATEWAY_URL: 'https://hermes.example.com',
  HERMES_API_SERVER_KEY: 'server-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
} as const;

test('assertHermesSocialContentRuntimeConfigured requires poll bridge for weekly social content', () => {
  assert.throws(
    () => assertHermesSocialContentRuntimeConfigured({ ...BASE_ENV, HERMES_POLL_BRIDGE_ENABLED: '0' }),
    /HERMES_POLL_BRIDGE_ENABLED must stay enabled/,
  );
});

test('probeHermesGatewayCapabilities verifies the polled-run contract Aries expects', async () => {
  const report = await probeHermesGatewayCapabilities(
    BASE_ENV,
    async () => new Response(JSON.stringify({
      endpoints: {
        runs: { path: '/v1/runs' },
        run_status: { path: '/v1/runs/{run_id}' },
        health: { path: '/health' },
      },
      features: {
        run_events_sse: true,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.requiredEndpoints, {
    runs: true,
    runStatus: true,
    health: true,
  });
  assert.equal(report.pollableRuns, true);
});

test('probeHermesSocialContentRuntime reports gateway and capabilities together', async () => {
  const responses = new Map<string, Response>([
    ['https://hermes.example.com/health', new Response(JSON.stringify({ status: 'ok', platform: 'hermes-agent' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
    ['https://hermes.example.com/v1/capabilities', new Response(JSON.stringify({
      endpoints: {
        runs: { path: '/v1/runs' },
        run_status: { path: '/v1/runs/{run_id}' },
        health: { path: '/health' },
      },
      features: {
        run_events_sse: true,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
  ]);

  const report = await probeHermesSocialContentRuntime(
    BASE_ENV,
    async (input) => {
      const response = responses.get(String(input));
      if (!response) {
        throw new Error(`unexpected URL: ${String(input)}`);
      }
      return response.clone();
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.workflow.key, 'social_content_weekly');
  assert.equal(report.workflow.version, SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION);
  assert.equal(report.callbackContract.callbackUrl, 'https://aries.example.com/api/internal/hermes/runs');
  assert.equal(report.callbackContract.directGatewayCallbacks, false);
  assert.equal(report.callbackContract.pollBridgeEnabled, true);
  assert.equal(report.gateway.ok, true);
  assert.equal(report.capabilities.ok, true);
});

test('health route returns 503 when Hermes runtime contract probe fails', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 503 })) as typeof fetch;
  try {
    const { GET } = await import('../app/api/health/hermes/route');
    const response = await GET();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.workflow.key, 'social_content_weekly');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

void test('instructions() forbids local-workspace tools during research — social content block', () => {
  const result = buildHermesInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY);
  assert.ok(result.includes('MUST NOT call read_file'), 'forbid clause must mention read_file');
  assert.ok(result.includes('search_files'), 'forbid clause must mention search_files');
  assert.ok(result.includes('write_file'), 'forbid clause must mention write_file');
  assert.ok(result.includes('execute_code'), 'forbid clause must mention execute_code');
  assert.ok(result.includes('6 total tool calls'), '6-tool-call cap must be present');
  assert.ok(result.includes('no Aries workspace available'), 'workspace-unavailable rationale must be present');
});

void test('instructions() forbids local-workspace tools during research — generic block', () => {
  const result = buildHermesInstructions('some_other_workflow');
  assert.ok(result.includes('MUST NOT call read_file'), 'forbid clause must mention read_file');
  assert.ok(result.includes('search_files'), 'forbid clause must mention search_files');
  assert.ok(result.includes('write_file'), 'forbid clause must mention write_file');
  assert.ok(result.includes('execute_code'), 'forbid clause must mention execute_code');
  assert.ok(result.includes('6 total tool calls'), '6-tool-call cap must be present');
  assert.ok(result.includes('no Aries workspace available'), 'workspace-unavailable rationale must be present');
});

// Test 30: buildSocialContentWeeklyRequest payload integration for enrichment fields

test('buildSocialContentWeeklyRequest payload: enrichment fields flow into brand.style_vibe, objective.audience, brand.voice (Tone: suffix), brand.offer (positioning-aware)', async () => {
  const { buildSocialContentWeeklyRequest } = await import('../backend/social-content/workflow-request');
  const doc = {
    tenant_id: 'tenant_enrich_payload',
    job_id: 'mkt_enrich_payload',
    inputs: {
      brand_url: 'https://example.com',
      request: {},
    },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Coach',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'Empowering leadership voice.',
      offer_summary: 'Leadership coaching programs.',
      positioning: 'For founders who need clarity.',
      audience: 'Early-stage founders.',
      tone_of_voice: 'warm, direct',
      style_vibe: 'minimalist, modern',
    },
  } as unknown as import('../backend/marketing/runtime-state').MarketingJobRuntimeDocument;

  const payload = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'run-enrich-payload',
    callbackUrl: 'https://aries.example.com/callback',
  });

  assert.equal(payload.input.brand.style_vibe, 'minimalist, modern', 'style_vibe should come from brandKit.style_vibe');
  assert.equal(payload.input.objective.audience, 'Early-stage founders.', 'audience should come from brandKit.audience');
  assert.equal(payload.input.brand.voice, 'Empowering leadership voice. Tone: warm, direct.', 'voice should include Tone: suffix');
  assert.ok(typeof payload.input.brand.offer === 'string' && payload.input.brand.offer.length > 0, 'offer should be non-empty');
});
