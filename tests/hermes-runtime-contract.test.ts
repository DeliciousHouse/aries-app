import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHermesSocialContentRuntimeConfigured,
  probeHermesGatewayCapabilities,
  probeHermesSocialContentRuntime,
} from '../backend/marketing/hermes-runtime-contract';
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
