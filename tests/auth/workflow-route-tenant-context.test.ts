import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCalendarSync } from '../../app/api/calendar/sync/handler';
import { handleIntegrationsSync } from '../../app/api/integrations/handlers';
import { handlePublishDispatch } from '../../app/api/publish/dispatch/handler';
import { handlePublishRetry } from '../../app/api/publish/retry/handler';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

test('calendar sync ignores forged tenant_id and uses authenticated tenant context', async () => {
  let captured: Record<string, unknown> | null = null;
  setOpenClawTestInvoker((payload) => {
    captured = payload;
    return {
      ok: true,
      status: 'ok',
      output: [{
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: 'calendar.sync',
        message: 'No production-parity OpenClaw workflow is installed for this route yet.',
      }],
      requiresApproval: null,
    };
  });
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
  const body = (await response.json()) as {
    status: string;
    reason: string;
    route: string;
  };

  assert.equal(response.status, 501);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'workflow_missing_for_route');
  assert.equal(body.route, 'calendar.sync');
  assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant_real');
  clearOpenClawTestInvoker();
});

test('publish retry ignores forged tenant_id and rejects missing tenant context', async () => {
  let captured: Record<string, unknown> | null = null;
  setOpenClawTestInvoker((payload) => {
    captured = payload;
    return {
      ok: true,
      status: 'ok',
      output: [{
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: 'publish.retry',
        message: 'No production-parity OpenClaw workflow is installed for this route yet.',
      }],
      requiresApproval: null,
    };
  });
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
  const acceptedBody = (await accepted.json()) as {
    status: string;
    reason: string;
    route: string;
  };

  assert.equal(accepted.status, 501);
  assert.equal(acceptedBody.status, 'error');
  assert.equal(acceptedBody.reason, 'workflow_missing_for_route');
  assert.equal(acceptedBody.route, 'publish.retry');
  assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant_real');

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
  clearOpenClawTestInvoker();
});

test('publish dispatch ignores forged tenant_id and rejects missing tenant context', async () => {
  let captured: Record<string, unknown> | null = null;
  setOpenClawTestInvoker((payload) => {
    captured = payload;
    return {
      ok: true,
      status: 'ok',
      output: [{
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: 'publish.dispatch',
        message: 'No production-parity OpenClaw workflow is installed for this route yet.',
      }],
      requiresApproval: null,
    };
  });
  const accepted = await handlePublishDispatch(
    new Request('http://localhost/api/publish/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'forged_tenant',
        provider: 'facebook',
        content: 'Ship it',
        media_urls: ['https://cdn.example.com/image.png'],
      }),
    }),
    async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    })
  );
  const acceptedBody = (await accepted.json()) as {
    status: string;
    reason: string;
    route: string;
  };

  assert.equal(accepted.status, 501);
  assert.equal(acceptedBody.status, 'error');
  assert.equal(acceptedBody.reason, 'workflow_missing_for_route');
  assert.equal(acceptedBody.route, 'publish.dispatch');
  assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant_real');

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
  clearOpenClawTestInvoker();
});

test('integrations sync ignores forged tenant_id and uses repo-managed workflow metadata', async () => {
  let captured: Record<string, unknown> | null = null;
  setOpenClawTestInvoker((payload) => {
    captured = payload;
    return {
      ok: true,
      status: 'ok',
      output: [{
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: 'integrations.sync',
        message: 'No production-parity OpenClaw workflow is installed for this route yet.',
      }],
      requiresApproval: null,
    };
  });
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
  const body = (await response.json()) as {
    status: string;
    reason: string;
    route: string;
  };

  assert.equal(response.status, 501);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'workflow_missing_for_route');
  assert.equal(body.route, 'integrations.sync');
  assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant_real');
  clearOpenClawTestInvoker();
});
