/**
 * Unit tests for reconcilePendingConnections (no live DB, no Composio API).
 *
 * Covers:
 *   - pending rows trigger refreshConnectionStatus
 *   - rows that refresh to 'connected' are counted as reconciled
 *   - per-row provider throw is isolated (other rows still processed)
 *   - the grace-window filter param is forwarded to the DB query
 *   - null provider (Composio disabled) returns a zeroed summary
 *   - top-level DB error returns a zeroed summary without throwing
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test \
 *     tests/composio-pending-reconciler.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcilePendingConnections,
  DEFAULT_RECONCILE_GRACE_MINUTES,
  type Queryable,
  type ReconcileSummary,
} from '../backend/integrations/composio/reconcile-pending-connections';
import type { AccountConnectionProvider } from '../backend/integrations/providers/interfaces';
import type { ConnectedAccount, IntegrationPlatform } from '../backend/integrations/providers/types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface PendingRow {
  tenant_id: number;
  platform: string;
  external_user_id: string;
}

function makePendingRow(platform: string, tenantId: number): PendingRow {
  return { tenant_id: tenantId, platform, external_user_id: `aries-tenant-${tenantId}` };
}

/**
 * Fake Queryable: always returns the supplied rows regardless of SQL. Captures
 * the query params so tests can assert on the grace-window value.
 */
function fakeDb(rows: PendingRow[] = []): Queryable & { capturedParams: unknown[][] } {
  const capturedParams: unknown[][] = [];
  return {
    capturedParams,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      capturedParams.push(params);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
  };
}

/**
 * Fake AccountConnectionProvider. For each (tenantId, platform) key, the
 * refreshResult map controls what refreshConnectionStatus returns (undefined =
 * return a 'connected' account; null = return null; Error = throw).
 */
function fakeProvider(opts?: {
  refreshResults?: Map<string, ConnectedAccount | null | Error>;
}): AccountConnectionProvider & { refreshCalls: Array<{ externalUserId: string; platform: string; tenantId: string }> } {
  const refreshCalls: Array<{ externalUserId: string; platform: string; tenantId: string }> = [];
  return {
    kind: 'composio' as const,
    refreshCalls,
    async createConnectLink() { throw new Error('not implemented'); },
    async listConnections() { return []; },
    async getConnection() { return null; },
    async disconnectConnection() { return { disconnected: false }; },
    async refreshConnectionStatus(externalUserId, platform, options) {
      const tenantId = options?.tenantId ?? '';
      refreshCalls.push({ externalUserId, platform, tenantId });
      const key = `${tenantId}:${platform}`;
      const result = opts?.refreshResults?.get(key);
      if (result instanceof Error) throw result;
      if (result === null) return null;
      // Default: connected
      return {
        id: '1',
        tenantId,
        externalUserId,
        platform: platform as IntegrationPlatform,
        provider: 'composio' as const,
        connectedAccountId: 'ca_1',
        authConfigId: null,
        externalAccountId: null,
        externalAccountName: null,
        status: 'connected' as const,
        capabilities: null,
        lastCapabilityCheckAt: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('reconcilePendingConnections: no pending rows → summary zeroed, no refresh calls', async () => {
  const db = fakeDb([]);
  const provider = fakeProvider();
  const summary = await reconcilePendingConnections({ db, provider });

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 0 } satisfies ReconcileSummary);
  assert.equal(provider.refreshCalls.length, 0);
});

test('reconcilePendingConnections: two pending rows both become connected → reconciled=2', async () => {
  const rows = [
    makePendingRow('facebook', 10),
    makePendingRow('instagram', 10),
  ];
  const db = fakeDb(rows);
  const provider = fakeProvider();
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.scanned, 2);
  assert.equal(summary.reconciled, 2);
  assert.equal(summary.stillPending, 0);
  assert.equal(summary.errors, 0);
  assert.equal(provider.refreshCalls.length, 2);
});

test('reconcilePendingConnections: refresh returns null → stillPending incremented', async () => {
  const rows = [makePendingRow('instagram', 15)];
  const db = fakeDb(rows);
  const results = new Map([['15:instagram', null] as const]);
  const provider = fakeProvider({ refreshResults: results });
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.reconciled, 0);
  assert.equal(summary.stillPending, 1);
  assert.equal(summary.errors, 0);
});

test('reconcilePendingConnections: per-row throw is isolated — other rows still processed', async () => {
  const rows = [
    makePendingRow('facebook', 10),
    makePendingRow('instagram', 10), // this one will throw
    makePendingRow('linkedin', 10),
  ];
  const db = fakeDb(rows);
  const results = new Map<string, ConnectedAccount | null | Error>([
    ['10:instagram', new Error('composio timeout')],
  ]);
  const provider = fakeProvider({ refreshResults: results });
  const summary = await reconcilePendingConnections({ db, provider });

  // facebook and linkedin reconciled; instagram errored
  assert.equal(summary.scanned, 3);
  assert.equal(summary.reconciled, 2);
  assert.equal(summary.stillPending, 0);
  assert.equal(summary.errors, 1);
  // All three rows were attempted
  assert.equal(provider.refreshCalls.length, 3);
});

test('reconcilePendingConnections: grace-window is forwarded to the DB query params', async () => {
  const db = fakeDb([]);
  const provider = fakeProvider();
  await reconcilePendingConnections({ db, provider, graceMinutes: 45 });

  assert.ok(db.capturedParams.length > 0, 'expected at least one query');
  assert.equal(db.capturedParams[0][0], 45, 'first query param must be the grace_minutes value');
});

test('reconcilePendingConnections: uses default grace minutes when not specified', async () => {
  const db = fakeDb([]);
  const provider = fakeProvider();
  await reconcilePendingConnections({ db, provider });

  assert.equal(
    db.capturedParams[0]?.[0],
    DEFAULT_RECONCILE_GRACE_MINUTES,
    `default grace should be ${DEFAULT_RECONCILE_GRACE_MINUTES}`,
  );
});

test('reconcilePendingConnections: null provider (Composio disabled) → zeroed summary, no DB hit', async () => {
  const db = fakeDb([makePendingRow('facebook', 1)]);
  const summary = await reconcilePendingConnections({ db, provider: null });

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 0 });
  // DB must not be touched — provider null is an early-return path
  assert.equal(db.capturedParams.length, 0, 'DB must not be queried when provider is null');
});

test('reconcilePendingConnections: top-level DB error returns zeroed summary without throwing', async () => {
  const brokenDb: Queryable = {
    async query() { throw new Error('connection pool exhausted'); },
  };
  const provider = fakeProvider();
  const summary = await reconcilePendingConnections({ db: brokenDb, provider });

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 1 });
});

test('reconcilePendingConnections: externalUserId and tenantId are forwarded to refreshConnectionStatus', async () => {
  const rows = [
    { tenant_id: 42, platform: 'facebook', external_user_id: 'aries-tenant-42' },
  ];
  const db = fakeDb(rows);
  const provider = fakeProvider();
  await reconcilePendingConnections({ db, provider });

  assert.equal(provider.refreshCalls.length, 1);
  assert.equal(provider.refreshCalls[0].externalUserId, 'aries-tenant-42');
  assert.equal(provider.refreshCalls[0].platform, 'facebook');
  assert.equal(provider.refreshCalls[0].tenantId, '42');
});
