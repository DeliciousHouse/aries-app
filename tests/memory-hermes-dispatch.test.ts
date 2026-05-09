import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchResearchJob } from '../backend/memory/hermes-dispatch';

const BASE_ENV = {
  HERMES_RESEARCH_WEBHOOK_URL: 'https://hermes.test/webhook/aries-research',
  HERMES_API_SERVER_KEY: 'server-key-abc',
  APP_BASE_URL: 'https://aries.example.com',
  ARIES_TENANT_PSEUDONYM_SALT: 'test-salt-for-unit-tests-1234',
};

const BASE_CTX = { tenantId: 'tenant-42' };

const BASE_TASK_SPEC = { jobType: 'brand_research', query: 'Find brand facts' };
const BASE_MEMORY: [] = [];
const CALLBACK_TOKEN = 'a'.repeat(64);

test('outbound payload contains tenantPseudonym not real tenantId', async () => {
  let captured: unknown = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    captured = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-123', taskSpec: BASE_TASK_SPEC, memoryContext: BASE_MEMORY, callbackToken: CALLBACK_TOKEN },
    BASE_ENV,
    fakeFetch,
  );

  assert.ok(captured, 'fetch should have been called');
  const payload = captured as Record<string, unknown>;

  assert.ok(!('tenantId' in payload), 'real tenantId must not appear in payload');
  assert.ok('tenantPseudonym' in payload, 'tenantPseudonym must be in payload');
  assert.equal(typeof payload.tenantPseudonym, 'string');
  assert.notEqual(payload.tenantPseudonym, 'tenant-42', 'pseudonym must differ from real tenantId');
  assert.match(payload.tenantPseudonym as string, /^[a-f0-9]{32}$/, 'pseudonym must be 32-char hex');
});

test('outbound payload has correct callback URL', async () => {
  let captured: unknown = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    captured = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-123', taskSpec: BASE_TASK_SPEC, memoryContext: BASE_MEMORY, callbackToken: CALLBACK_TOKEN },
    BASE_ENV,
    fakeFetch,
  );

  const payload = captured as Record<string, unknown>;
  assert.equal(payload.callbackUrl, 'https://aries.example.com/api/internal/hermes/runs');
});

test('outbound request uses HERMES_API_SERVER_KEY as Bearer token', async () => {
  let capturedHeaders: Record<string, string> | null = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-123', taskSpec: BASE_TASK_SPEC, memoryContext: BASE_MEMORY, callbackToken: CALLBACK_TOKEN },
    BASE_ENV,
    fakeFetch,
  );

  assert.ok(capturedHeaders, 'headers should be captured');
  const headers = capturedHeaders as Record<string, string>;
  const authHeader = headers.authorization ?? headers.Authorization ?? '';
  assert.equal(authHeader, `Bearer server-key-abc`);
});

test('outbound payload contains jobId and callbackToken', async () => {
  let captured: unknown = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    captured = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-456', taskSpec: BASE_TASK_SPEC, memoryContext: BASE_MEMORY, callbackToken: CALLBACK_TOKEN },
    BASE_ENV,
    fakeFetch,
  );

  const payload = captured as Record<string, unknown>;
  assert.equal(payload.jobId, 'job-456');
  assert.equal(payload.callbackToken, CALLBACK_TOKEN);
});

test('returns error when HERMES_RESEARCH_WEBHOOK_URL is missing', async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error('should not be called');
  };

  const result = await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-x', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    { ...BASE_ENV, HERMES_RESEARCH_WEBHOOK_URL: undefined },
    fakeFetch,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /HERMES_RESEARCH_WEBHOOK_URL/);
});

test('returns error when Hermes returns non-2xx', async () => {
  const fakeFetch: typeof fetch = async () => {
    return new Response('bad gateway', { status: 502 });
  };

  const result = await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-y', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    BASE_ENV,
    fakeFetch,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /502/);
});

test('tenantPseudonym is deterministic for same tenantId and salt', async () => {
  const pseudonyms: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    pseudonyms.push(body.tenantPseudonym as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-a', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    BASE_ENV,
    fakeFetch,
  );
  await dispatchResearchJob(
    BASE_CTX,
    { jobId: 'job-b', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    BASE_ENV,
    fakeFetch,
  );

  assert.equal(pseudonyms[0], pseudonyms[1], 'same tenant should produce same pseudonym');
});

test('different tenants produce different pseudonyms', async () => {
  const pseudonyms: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    pseudonyms.push(body.tenantPseudonym as string);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await dispatchResearchJob(
    { tenantId: 'tenant-A' },
    { jobId: 'job-a', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    BASE_ENV,
    fakeFetch,
  );
  await dispatchResearchJob(
    { tenantId: 'tenant-B' },
    { jobId: 'job-b', taskSpec: {}, memoryContext: [], callbackToken: 'tok' },
    BASE_ENV,
    fakeFetch,
  );

  assert.notEqual(pseudonyms[0], pseudonyms[1], 'different tenants should produce different pseudonyms');
});
