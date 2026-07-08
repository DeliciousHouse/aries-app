/**
 * tests/insights-narrative-connection-error.test.ts
 *
 * Regression for S1-4 / AA-83: the narrative hero connect-gate must NOT report a
 * DB/query failure as "not_connected" (which makes the UI say "connect
 * <platform>" during a backend outage). A thrown connection-check query must
 * surface a distinct, retryable error state (HTTP 503), while a genuine miss
 * still returns not_connected (200).
 *
 * Drives the real handler with a stub tenant loader (no session) and monkey-
 * patches the shared pg pool's `query` so no live DB is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../lib/db';
import { handleGetInsightsNarrative } from '../backend/insights/narrative/handler';

const loader = async () =>
  ({ tenantId: '1', tenantSlug: 'insights-demo', role: 'tenant_admin', userId: '1' }) as any;

const req = (platform: string) =>
  new Request(`https://x.test/api/insights/narrative?period=90day&platform=${platform}`);

test('DB error during the connection check → 503 retryable error, NOT not_connected (S1-4/AA-83)', async () => {
  const original = pool.query;
  (pool as any).query = async () => { throw new Error('simulated DB outage'); };
  try {
    const res = await handleGetInsightsNarrative(req('facebook'), loader as any);
    const body: any = await res.json();
    assert.equal(res.status, 503, 'a backend/DB error must be a 503, not a 200');
    assert.equal(body.status, 'error');
    assert.equal(body.retryable, true);
    assert.notEqual(body.status, 'not_connected', 'a DB error must not masquerade as not_connected');
  } finally {
    (pool as any).query = original;
  }
});

test('genuinely unconnected platform still returns not_connected (200)', async () => {
  const original = pool.query;
  (pool as any).query = async () => ({ rows: [{ connected: false }] }) as any;
  try {
    const res = await handleGetInsightsNarrative(req('facebook'), loader as any);
    const body: any = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'not_connected');
    assert.equal(body.connect_url, '/integrations');
  } finally {
    (pool as any).query = original;
  }
});
