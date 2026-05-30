import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCalendarSync } from '../../app/api/calendar/sync/handler';
import { handleIntegrationsSync } from '../../app/api/integrations/handlers';
import { handlePublishDispatch } from '../../app/api/publish/dispatch/handler';
import { handlePublishRetry } from '../../app/api/publish/retry/handler';

// Route handlers reach Hermes via runAriesWorkflow -> getExecutionProvider() ->
// new HermesExecutionAdapter(process.env), which uses globalThis.fetch. To
// exercise the real "accepted" path (HTTP 202) without a live gateway we
// configure Hermes env vars and stub globalThis.fetch: POST /v1/runs captures
// the submitted prompt (which embeds the workflow args JSON) and returns a
// run id; GET /v1/runs/:id returns a completed envelope. Capturing the prompt
// lets us assert the tenant-isolation guarantee directly: the authenticated
// tenant (tenant_real) is what reaches the workflow, and the forged body
// tenant_id (forged_tenant) never does.
const HERMES_TEST_ENV: Record<string, string> = {
  HERMES_GATEWAY_URL: 'http://hermes.test',
  HERMES_API_SERVER_KEY: 'k',
  HERMES_RUN_TIMEOUT_MS: '500',
  HERMES_POLL_INTERVAL_MS: '10',
};

type FetchStub = {
  restore: () => void;
  /** The `input` prompt string captured from the POST /v1/runs body. */
  capturedInput: () => string;
};

function installHermesFetchStub(): FetchStub {
  const previousEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(HERMES_TEST_ENV)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const originalFetch = globalThis.fetch;
  let captured = '';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/v1/runs')) {
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(rawBody) as { input?: unknown };
      captured = typeof parsed.input === 'string' ? parsed.input : '';
      return new Response(JSON.stringify({ run_id: 'r1', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/v1\/runs\//.test(url)) {
      return new Response(
        JSON.stringify({
          run_id: 'r1',
          status: 'completed',
          output: JSON.stringify({ status: 'ok', output: [{ ok: true }] }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;

  return {
    capturedInput: () => captured,
    restore: () => {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(HERMES_TEST_ENV)) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
    },
  };
}

/** Assert the captured workflow prompt carries the authenticated tenant and never the forged one. */
function assertTenantIsolation(capturedInput: string): void {
  assert.match(capturedInput, /"tenant_id":"tenant_real"/);
  assert.ok(!capturedInput.includes('forged_tenant'));
}

test('calendar sync ignores forged tenant_id and uses authenticated tenant context', async () => {
  const stub = installHermesFetchStub();
  try {
    const response = await handleCalendarSync(
      new Request('http://localhost/api/calendar/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'forged_tenant',
          window_start: '2026-03-01T00:00:00.000Z',
          window_end: '2026-03-31T23:59:59.999Z',
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as { status: string };

    assert.equal(response.status, 202);
    assert.equal(body.status, 'accepted');
    assertTenantIsolation(stub.capturedInput());
  } finally {
    stub.restore();
  }
});

test('publish retry ignores forged tenant_id and rejects missing tenant context', async () => {
  const stub = installHermesFetchStub();
  try {
    const accepted = await handlePublishRetry(
      new Request('http://localhost/api/publish/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'forged_tenant',
          max_attempts: 4,
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const acceptedBody = (await accepted.json()) as { status: string };

    assert.equal(accepted.status, 202);
    assert.equal(acceptedBody.status, 'accepted');
    assertTenantIsolation(stub.capturedInput());

    const rejected = await handlePublishRetry(
      new Request('http://localhost/api/publish/retry', { method: 'POST' }),
      async () => {
        throw new Error('Authentication required.');
      }
    );
    const rejectedBody = (await rejected.json()) as {
      status: string;
      reason: string;
      message: string;
    };

    assert.equal(rejected.status, 403);
    assert.equal(rejectedBody.status, 'error');
    assert.equal(rejectedBody.reason, 'tenant_context_required');
  } finally {
    stub.restore();
  }
});

test('publish dispatch ignores forged tenant_id and rejects missing tenant context', async () => {
  const stub = installHermesFetchStub();
  try {
    const accepted = await handlePublishDispatch(
      new Request('http://localhost/api/publish/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'forged_tenant',
          provider: 'linkedin',
          content: 'Ship it',
          // No media_urls so assertMediaUrlsBelongToTenant no-ops (it requires a
          // DB-backed creative_assets row); the tenant-isolation guarantee under
          // test is the workflow tenant_id, not the media-ownership guard which
          // has its own dedicated coverage.
          media_urls: [],
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const acceptedBody = (await accepted.json()) as { status: string };

    assert.equal(accepted.status, 202);
    assert.equal(acceptedBody.status, 'accepted');
    assertTenantIsolation(stub.capturedInput());

    const rejected = await handlePublishDispatch(
      new Request('http://localhost/api/publish/dispatch', { method: 'POST' }),
      async () => {
        throw new Error('Authentication required.');
      }
    );
    const rejectedBody = (await rejected.json()) as {
      status: string;
      reason: string;
      message: string;
    };

    assert.equal(rejected.status, 403);
    assert.equal(rejectedBody.status, 'error');
    assert.equal(rejectedBody.reason, 'tenant_context_required');
  } finally {
    stub.restore();
  }
});

test('integrations sync ignores forged tenant_id and uses repo-managed workflow metadata', async () => {
  const stub = installHermesFetchStub();
  try {
    const response = await handleIntegrationsSync(
      new Request('http://localhost/api/integrations/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'forged_tenant',
          platform: 'facebook',
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as { status: string };

    assert.equal(response.status, 202);
    assert.equal(body.status, 'accepted');
    assertTenantIsolation(stub.capturedInput());
  } finally {
    stub.restore();
  }
});
