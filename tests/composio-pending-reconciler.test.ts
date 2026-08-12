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
 * Fake Queryable. The sweep issues TWO different queries — the pending
 * promotion sweep (`status = 'pending'`) and the demotion re-check
 * (`status = ANY(...)`) — so this routes by SQL shape. Returning the same rows
 * to both would make every promotion test also run a phantom re-check.
 * Captures params so tests can assert on the grace/recheck windows.
 */
function fakeDb(
  rows: PendingRow[] = [],
  recheckRows: Array<PendingRow & { status: string }> = [],
): Queryable & { capturedParams: unknown[][] } {
  const capturedParams: unknown[][] = [];
  return {
    capturedParams,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      capturedParams.push(params);
      const isRecheck = text.includes('status = ANY');
      const out = isRecheck ? recheckRows : rows;
      return { rows: out as unknown as T[], rowCount: out.length };
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

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 0, rechecked: 0, demoted: 0 } satisfies ReconcileSummary);
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

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 0, rechecked: 0, demoted: 0 });
  // DB must not be touched — provider null is an early-return path
  assert.equal(db.capturedParams.length, 0, 'DB must not be queried when provider is null');
});

test('reconcilePendingConnections: top-level DB error returns zeroed summary without throwing', async () => {
  const brokenDb: Queryable = {
    async query() { throw new Error('connection pool exhausted'); },
  };
  const provider = fakeProvider();
  const summary = await reconcilePendingConnections({ db: brokenDb, provider });

  assert.deepEqual(summary, { scanned: 0, reconciled: 0, stillPending: 0, errors: 1, rechecked: 0, demoted: 0 });
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

// ---------------------------------------------------------------------------
// Demotion pass (2026-08-12)
//
// Before this existed, `connected` was a terminal state: the sweep only looked
// at `pending` rows, so a channel that DIED kept reporting connected forever.
// Tenant 15's X connection sat green for ~28 days after Composio recorded a
// permanent refresh failure — the UI advertised it, the publish gate trusted
// it, and a week of posts dead-lettered.
//
// The most important test here is the FAIL-SAFE one: an unreachable Composio
// must never demote a working channel, or a display bug becomes an outage.
// ---------------------------------------------------------------------------

function makeRecheckRow(platform: string, tenantId: number, status = 'connected') {
  return { tenant_id: tenantId, platform, external_user_id: `aries-tenant-${tenantId}`, status };
}

test('demotion: a believed-connected row that is no longer connected is demoted and counted', async () => {
  const db = fakeDb([], [makeRecheckRow('x', 15)]);
  // refresh returns null → not connected any more
  const provider = fakeProvider({ refreshResults: new Map([['15:x', null] as const]) });
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.rechecked, 1);
  assert.equal(summary.demoted, 1, 'a dead channel must be demoted');
  assert.equal(provider.refreshCalls.length, 1);
});

test('demotion: a still-healthy row is re-verified but NOT demoted', async () => {
  const db = fakeDb([], [makeRecheckRow('facebook', 15)]);
  const provider = fakeProvider(); // default → connected
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.rechecked, 1);
  assert.equal(summary.demoted, 0, 'a live channel must never be demoted');
});

test('FAIL-SAFE: an unreachable Composio does NOT demote a live channel', async () => {
  // refreshConnectionStatus throws when Composio cannot be reached. That is not
  // evidence the channel is dead — demoting here would disconnect working
  // channels during a provider blip.
  const db = fakeDb([], [makeRecheckRow('facebook', 15), makeRecheckRow('instagram', 15)]);
  const provider = fakeProvider({
    refreshResults: new Map<string, ConnectedAccount | null | Error>([
      ['15:facebook', new Error('composio unreachable')],
      ['15:instagram', new Error('composio unreachable')],
    ]),
  });
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.rechecked, 2);
  assert.equal(summary.demoted, 0, 'a transient provider error must NEVER demote');
  assert.equal(summary.errors, 2, 'the failures are surfaced as errors instead');
});

test('demotion: a previously-broken row that is healthy again heals back, not demoted', async () => {
  const db = fakeDb([], [makeRecheckRow('x', 15, 'reauthorization_required')]);
  const provider = fakeProvider(); // default → connected
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.rechecked, 1);
  assert.equal(summary.demoted, 0, 'healing is not a demotion');
});

test('demotion: recheck window + limit are forwarded to the DB query', async () => {
  const db = fakeDb([], []);
  const provider = fakeProvider();
  await reconcilePendingConnections({ db, provider, recheckHours: 12, recheckLimit: 7 });

  const recheckParams = db.capturedParams[1];
  assert.ok(recheckParams, 'expected a second (recheck) query');
  assert.deepEqual(recheckParams[0], ['connected', 'reauthorization_required']);
  assert.equal(recheckParams[1], 12);
  assert.equal(recheckParams[2], 7);
});

test('demotion pass runs even when there are no pending rows to promote', async () => {
  // The two passes are independent: an empty promotion sweep must not skip the
  // re-check, or a fleet with no in-flight connects would never be audited.
  const db = fakeDb([], [makeRecheckRow('x', 15)]);
  const provider = fakeProvider({ refreshResults: new Map([['15:x', null] as const]) });
  const summary = await reconcilePendingConnections({ db, provider });

  assert.equal(summary.scanned, 0);
  assert.equal(summary.demoted, 1);
});
