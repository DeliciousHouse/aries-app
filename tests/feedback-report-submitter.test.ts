import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashIp } from '../lib/feedback/submission';
import { resolveReportSubmitter } from '../backend/feedback/report-submitter';

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
    },
  );

  assert.equal(submitter.attribution, 'anonymous');
  assert.equal(submitter.userId, `anonymous:${hashIp('198.51.100.42')}`);
  assert.ok(!submitter.userId.includes('198.51.100.42'), 'raw client IP must never be persisted');
  assert.equal(submitter.email, null);
  assert.equal(submitter.name, null);
  assert.equal(submitter.tenantId, 'anonymous');
  assert.equal(submitter.tenantSlug, 'anonymous');
  assert.equal(tenantContextCalls, 0);
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

test('authenticated report submitters keep session attribution and authoritative tenant context', async () => {
  const submitter = await resolveReportSubmitter(new Headers(), {
    readSession: async () => ({
      user: {
        id: 'session-user',
        email: 'jo@example.com',
        name: 'Jo',
        tenantId: 'session-tenant',
        tenantSlug: 'session-slug',
      },
    }),
    readTenantContext: async () => ({
      userId: 'db-user',
      tenantId: 'db-tenant',
      tenantSlug: 'db-slug',
    }),
  });

  assert.deepEqual(submitter, {
    attribution: 'authenticated',
    userId: 'db-user',
    email: 'jo@example.com',
    name: 'Jo',
    tenantId: 'db-tenant',
    tenantSlug: 'db-slug',
  });
});

test('submit route resolves an anonymous fallback instead of returning 401 before persistence', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'api', 'feedback', 'submit', 'route.ts'),
    'utf8',
  );

  assert.match(source, /resolveReportSubmitter\(req\.headers/);
  assert.doesNotMatch(source, /error:\s*'unauthorized'/);
  assert.doesNotMatch(source, /status:\s*401/);
});
