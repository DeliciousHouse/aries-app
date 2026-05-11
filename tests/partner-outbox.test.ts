import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, test } from 'node:test';

import {
  computePartnerAttributionBackoffSeconds,
  drainPartnerAttributionOutboxOnce,
  enqueuePartnerAttribution,
} from '@/backend/partners/outbox';
import type { AriesSignupPayload, VmsPostResult } from '@/backend/partners/vms-client';

beforeEach(() => {
  process.env.PARTNER_ATTRIBUTION_ENABLED = 'true';
  process.env.VMS_BASE_URL = 'http://vms.test';
  process.env.VMS_WEBHOOK_SECRET = 'whsec_test';
});

afterEach(() => {
  delete process.env.PARTNER_ATTRIBUTION_ENABLED;
  delete process.env.VMS_BASE_URL;
  delete process.env.VMS_WEBHOOK_SECRET;
});

test('computePartnerAttributionBackoffSeconds caps at 1 hour', () => {
  assert.equal(computePartnerAttributionBackoffSeconds(1), 30);
  assert.equal(computePartnerAttributionBackoffSeconds(2), 60);
  assert.equal(computePartnerAttributionBackoffSeconds(10), 3600);
});

test('enqueuePartnerAttribution inserts when delivery is configured', async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return { rowCount: 1, rows: [] };
    },
  } as unknown as PoolClient;

  await enqueuePartnerAttribution(client, {
    userId: '42',
    refCode: 'ref9',
    name: 'N',
    email: 'e@x.com',
    company: 'C',
    domain: 'x.com',
  });

  assert.ok(statements.some((s) => s.includes('INSERT INTO partner_attribution_outbox')));
});

test('enqueuePartnerAttribution is a no-op when delivery is not configured', async () => {
  delete process.env.VMS_WEBHOOK_SECRET;
  let called = false;
  const client = {
    async query() {
      called = true;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  await enqueuePartnerAttribution(client, {
    userId: '1',
    refCode: 'ref9',
    name: 'N',
    email: 'e@x.com',
  });
  assert.equal(called, false);
});

test('drainPartnerAttributionOutboxOnce marks delivered on 201', async () => {
  const row = {
    id: 1,
    user_id: '1',
    ref_code: 'ref9',
    name: 'N',
    email: 'e@x.com',
    company: null,
    domain: 'x.com',
    attempts: 0,
  };
  let delivered = false;
  const client = {
    async query(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN')) return { rowCount: 0 };
      if (s.startsWith('COMMIT')) return { rowCount: 0 };
      if (s.startsWith('ROLLBACK')) return { rowCount: 0 };
      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        return { rowCount: 1, rows: [row] };
      }
      if (s.includes("status = 'delivered'")) {
        delivered = true;
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  const poster = async (_p: AriesSignupPayload): Promise<VmsPostResult> => ({ ok: true, status: 201 });
  const n = await drainPartnerAttributionOutboxOnce(client, poster);
  assert.equal(n, 1);
  assert.equal(delivered, true);
});

test('drainPartnerAttributionOutboxOnce marks dead on 401', async () => {
  const row = {
    id: 2,
    user_id: '2',
    ref_code: 'ref9',
    name: 'N',
    email: 'e@x.com',
    company: null,
    domain: 'x.com',
    attempts: 0,
  };
  let dead = false;
  const client = {
    async query(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN')) return { rowCount: 0 };
      if (s.startsWith('COMMIT')) return { rowCount: 0 };
      if (s.startsWith('ROLLBACK')) return { rowCount: 0 };
      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        return { rowCount: 1, rows: [row] };
      }
      if (s.includes("status = 'dead'")) {
        dead = true;
        return { rowCount: 1 };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  const poster = async (_p: AriesSignupPayload): Promise<VmsPostResult> => ({
    ok: false,
    retryable: false,
    status: 401,
    terminalReason: 'unauthorized',
  });
  const n = await drainPartnerAttributionOutboxOnce(client, poster);
  assert.equal(n, 1);
  assert.equal(dead, true);
});

test('drainPartnerAttributionOutboxOnce returns 0 when no pending rows', async () => {
  const client = {
    async query(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN')) return { rowCount: 0 };
      if (s.startsWith('COMMIT')) return { rowCount: 0 };
      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;

  const n = await drainPartnerAttributionOutboxOnce(client, async () => ({ ok: true, status: 201 }));
  assert.equal(n, 0);
});
