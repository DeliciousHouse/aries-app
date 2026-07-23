import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashIp } from '../lib/feedback/submission';
import {
  ReportTenantAttributionError,
  resolveReportSubmitter,
  verifiedClientIpFromHeaders,
} from '../backend/feedback/report-submitter';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('anonymous report submitters use a stable IP hash without storing raw IP or fake contact details', async () => {
  let tenantContextCalls = 0;
  const submitter = await resolveReportSubmitter(
    new Headers({ 'x-forwarded-for': '198.51.100.42, 10.0.0.1' }),
    {
      readSession: async () => null,
      readTenantContext: async () => {
        tenantContextCalls += 1;
        throw new Error('anonymous requests must not resolve tenant context');
      },
      readVerifiedClientIp: () => '198.51.100.42',
    },
  );

  assert.equal(submitter.attribution, 'anonymous');
  assert.equal(submitter.userId, `anonymous:${hashIp('198.51.100.42')}`);
  assert.ok(!submitter.userId.includes('198.51.100.42'), 'raw client IP must never be persisted');
  assert.equal(submitter.tenantId, 'anonymous');
  assert.equal(tenantContextCalls, 0);
});

test('forwarded-IP rotation cannot mint anonymous buckets without the trusted proxy proof', async () => {
  const first = await resolveReportSubmitter(
    new Headers({ 'x-forwarded-for': '198.51.100.10' }),
    { readSession: async () => null, readTenantContext: async () => null as never },
  );
  const rotated = await resolveReportSubmitter(
    new Headers({ 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.100' }),
    { readSession: async () => null, readTenantContext: async () => null as never },
  );

  assert.equal(first.userId, 'anonymous:unknown');
  assert.equal(rotated.userId, first.userId);
});

test('trusted proxy forwarding is accepted only with a server-side shared proof', () => {
  const env = {
    ARIES_TRUSTED_PROXY_SECRET: 'server-only-secret',
  } as unknown as NodeJS.ProcessEnv;
  const forwarded = new Headers({
    'x-aries-proxy-verification': 'server-only-secret',
    'x-forwarded-for': '198.51.100.42, 10.0.0.1',
  });
  assert.equal(verifiedClientIpFromHeaders(forwarded, env), '198.51.100.42');
  forwarded.set('x-aries-proxy-verification', 'attacker-value');
  assert.equal(verifiedClientIpFromHeaders(forwarded, env), null);
});

test('auth lookup failures fail open to the shared headerless anonymous rate-limit bucket', async () => {
  const submitter = await resolveReportSubmitter(new Headers(), {
    readSession: async () => {
      throw new Error('expired session');
    },
    readTenantContext: async () => {
      throw new Error('must not run');
    },
  });

  assert.equal(submitter.attribution, 'anonymous');
  assert.equal(submitter.userId, 'anonymous:unknown');
});

test('authenticated report submitters keep only opaque authoritative tenant attribution', async () => {
  const submitter = await resolveReportSubmitter(new Headers(), {
    readSession: async () => ({
      user: {
        id: 'db-user',
      },
    }),
    readTenantContext: async () => ({
      userId: 'db-user',
      tenantId: 'db-tenant',
    }),
  });

  assert.deepEqual(submitter, {
    attribution: 'authenticated',
    userId: 'db-user',
    tenantId: 'db-tenant',
  });
});

test('authenticated attribution fails closed when current membership cannot be verified', async () => {
  await assert.rejects(
    () =>
      resolveReportSubmitter(new Headers(), {
        readSession: async () => ({ user: { id: 'user-1' } }),
        readTenantContext: async () => {
          throw new Error('membership database unavailable');
        },
      }),
    ReportTenantAttributionError,
  );
});

test('authenticated attribution rejects a tenant context for a different user', async () => {
  await assert.rejects(
    () =>
      resolveReportSubmitter(new Headers(), {
        readSession: async () => ({ user: { id: 'session-user' } }),
        readTenantContext: async () => ({
          userId: 'other-user',
          tenantId: 'db-tenant',
        }),
      }),
    ReportTenantAttributionError,
  );
});

test('submit route resolves an anonymous fallback instead of returning 401 before persistence', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'api', 'feedback', 'submit', 'route.ts'),
    'utf8',
  );

  assert.match(source, /resolveReportSubmitter\(req\.headers/);
  assert.match(source, /requireLiveMembership:\s*true/);
  assert.doesNotMatch(source, /return\s+NextResponse\.json\([^)]*unauthorized/i);
  assert.doesNotMatch(source, /status:\s*401/);

  const dialogSource = readFileSync(
    path.join(process.cwd(), 'frontend/feedback/report-dialog.tsx'),
    'utf8',
  );
  assert.match(dialogSource, /requestJson<Record<string, unknown>>\('\/api\/feedback\/submit'/);
  assert.doesNotMatch(dialogSource, /fetch\('\/api\/feedback\/submit'/);
});
