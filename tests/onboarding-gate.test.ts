import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_REDIRECT_DESTINATION,
  GUARDED_OPERATOR_PATH_PREFIXES,
  META_CONNECT_REDIRECT_DESTINATION,
  countConnectedMetaPlatforms,
  evaluateOnboardingGate,
  shouldGuardPathname,
  type OnboardingGateQueryable,
} from '../lib/onboarding-gate';
import { tenantNeedsMetaConnection } from '../lib/tenant-needs-meta-connection';

type FakeRow = Record<string, unknown>;

type FakeQueryHandler = (sql: string, params: unknown[]) => { rows: FakeRow[]; rowCount: number };

function makeQueryable(handler: FakeQueryHandler): OnboardingGateQueryable {
  return {
    query: async (sql: string, params: unknown[]) => {
      const result = handler(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  } as unknown as OnboardingGateQueryable;
}

function metaConnectionCounter(value: number) {
  return makeQueryable((sql, params) => {
    if (
      sql.includes('FROM oauth_connections') &&
      sql.includes("status = 'connected'") &&
      sql.includes("'facebook'") &&
      sql.includes("'instagram'")
    ) {
      assert.equal(params[0], 42, 'tenant id should be passed as numeric param');
      return { rows: [{ connected_count: value }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

test('shouldGuardPathname returns true for guarded operator route prefixes', () => {
  for (const prefix of GUARDED_OPERATOR_PATH_PREFIXES) {
    assert.equal(shouldGuardPathname(prefix), true, `${prefix} should be guarded`);
    assert.equal(shouldGuardPathname(`${prefix}/sub`), true, `${prefix}/sub should be guarded`);
    assert.equal(
      shouldGuardPathname(`${prefix}/sub/leaf?x=1`),
      true,
      `${prefix}/sub/leaf?x=1 should be guarded`,
    );
  }
});

test('shouldGuardPathname returns false for public and onboarding paths', () => {
  const publicPaths = [
    '/',
    '/features',
    '/documentation',
    '/api-docs',
    '/login',
    '/signup',
    '/onboarding/start',
    '/onboarding/connect/meta',
    '/api/integrations',
    '/auth/post-login',
  ];
  for (const pathname of publicPaths) {
    assert.equal(shouldGuardPathname(pathname), false, `${pathname} should not be guarded`);
  }
});

test('shouldGuardPathname returns false for empty pathname', () => {
  assert.equal(shouldGuardPathname(''), false);
});

test('countConnectedMetaPlatforms returns 0 for invalid tenant id', async () => {
  const queryable = makeQueryable(() => {
    throw new Error('should not query for invalid tenant');
  });

  assert.equal(await countConnectedMetaPlatforms(queryable, ''), 0);
  assert.equal(await countConnectedMetaPlatforms(queryable, 'abc'), 0);
  assert.equal(await countConnectedMetaPlatforms(queryable, '0'), 0);
  assert.equal(await countConnectedMetaPlatforms(queryable, '-1'), 0);
});

test('countConnectedMetaPlatforms returns count from query result', async () => {
  const queryable = metaConnectionCounter(2);
  assert.equal(await countConnectedMetaPlatforms(queryable, '42'), 2);
});

test('countConnectedMetaPlatforms counts Composio connected_accounts as well as direct-Meta (#600/#605)', async () => {
  let capturedSql = '';
  const queryable = makeQueryable((sql, params) => {
    capturedSql = sql;
    assert.equal(params[0], 42, 'tenant id passed as numeric param');
    return { rows: [{ connected_count: 1 }], rowCount: 1 };
  });
  const count = await countConnectedMetaPlatforms(queryable, '42');
  assert.equal(count, 1);
  // Recognition must read BOTH stores so a Composio-connected tenant isn't
  // treated as unconnected — while direct-Meta (oauth_connections) is preserved.
  assert.ok(capturedSql.includes('FROM oauth_connections'), 'still counts direct-Meta oauth_connections');
  assert.ok(capturedSql.includes('FROM connected_accounts'), 'also counts Composio connected_accounts');
  assert.ok(
    capturedSql.includes("platform IN ('facebook', 'instagram')"),
    'connected_accounts scoped to FB/IG platforms',
  );
  // Both branches require a fully-connected status (a pending link never counts).
  assert.ok((capturedSql.match(/status = 'connected'/g) ?? []).length >= 2, "both stores require status='connected'");
});

test('countConnectedMetaPlatforms returns 0 when query returns empty rows', async () => {
  const queryable = makeQueryable(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await countConnectedMetaPlatforms(queryable, '42'), 0);
});

test('evaluateOnboardingGate redirects when business profile is incomplete', async () => {
  let connectionCounterCalled = false;
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => true,
    connectionCounter: async () => {
      connectionCounterCalled = true;
      return 0;
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'profile_incomplete');
  assert.equal(decision.redirectTo, GATE_REDIRECT_DESTINATION);
  assert.equal(decision.redirectTo, '/onboarding/start');
  assert.deepEqual(decision.advisories, []);
  assert.equal(
    connectionCounterCalled,
    false,
    'connection counter should be skipped when profile is incomplete',
  );
});

test('evaluateOnboardingGate allows access but emits meta_not_connected advisory when profile is complete and no Meta/IG connections exist', async () => {
  // Soft gate: profile-complete users get the dashboard with a soft advisory
  // banner. The previous hard redirect to META_CONNECT_REDIRECT_DESTINATION
  // would loop users who disconnected Meta back through the OAuth screen.
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => false,
    connectionCounter: async () => 0,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'meta_not_connected');
  assert.equal(decision.redirectTo, null);
  assert.equal(decision.advisories.length, 1);
  const advisory = decision.advisories[0];
  assert.equal(advisory.kind, 'meta_not_connected');
  assert.equal(advisory.severity, 'warning');
  assert.equal(advisory.ctaHref, '/dashboard/settings/channel-integrations');
  assert.ok(typeof advisory.message === 'string' && advisory.message.length > 0);
  // META_CONNECT_REDIRECT_DESTINATION still exists for CTA deep-links but is
  // never the redirectTo for a gate decision after the soft-gate flip.
  assert.equal(META_CONNECT_REDIRECT_DESTINATION, '/oauth/connect/facebook');
});

test('evaluateOnboardingGate allows access when profile is complete and one Meta/IG connection exists', async () => {
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => false,
    connectionCounter: async () => 1,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowed');
  assert.equal(decision.redirectTo, null);
  assert.equal(decision.advisories.length, 0);
});

test('evaluateOnboardingGate allows access with multiple connections', async () => {
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => false,
    connectionCounter: async () => 2,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowed');
  assert.equal(decision.advisories.length, 0);
});

test('evaluateOnboardingGate treats profile resolver throw as incomplete', async () => {
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => {
      throw new Error('tenant_not_found');
    },
    connectionCounter: async () => 5,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'profile_incomplete');
});

test('evaluateOnboardingGate uses real connection-count SQL when no counter override is supplied', async () => {
  let observedSql: string | null = null;
  let observedParams: unknown[] | null = null;
  const queryable = makeQueryable((sql, params) => {
    observedSql = sql;
    observedParams = params;
    if (sql.includes('FROM oauth_connections')) {
      return { rows: [{ connected_count: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const decision = await evaluateOnboardingGate({
    client: queryable,
    tenantId: '42',
    profileIncompleteResolver: async () => false,
  });

  assert.equal(decision.allowed, true);
  assert.ok(observedSql, 'connection-count SQL should have been issued');
  const sqlText = observedSql ?? '';
  assert.match(sqlText, /FROM oauth_connections/);
  assert.match(sqlText, /status\s*=\s*'connected'/);
  assert.match(sqlText, /'facebook'/);
  assert.match(sqlText, /'instagram'/);
  assert.match(sqlText, /tenant_id\s*=\s*\$1/);
  assert.deepEqual(observedParams, [42]);
});

test('tenantNeedsMetaConnection returns true when zero connections exist', async () => {
  const queryable = makeQueryable(() => ({ rows: [], rowCount: 0 }));
  const result = await tenantNeedsMetaConnection(queryable, '42', async () => 0);
  assert.equal(result, true);
});

test('tenantNeedsMetaConnection returns false when at least one connection exists', async () => {
  const queryable = makeQueryable(() => ({ rows: [], rowCount: 0 }));
  const result = await tenantNeedsMetaConnection(queryable, '42', async () => 1);
  assert.equal(result, false);
});

test('tenantNeedsMetaConnection returns true for invalid tenant id (fail-safe)', async () => {
  const queryable = makeQueryable(() => {
    throw new Error('should not query for invalid tenant');
  });
  // Uses real countConnectedMetaPlatforms, which short-circuits to 0 for
  // invalid ids, so tenantNeedsMetaConnection returns true (needs to connect).
  assert.equal(await tenantNeedsMetaConnection(queryable, ''), true);
  assert.equal(await tenantNeedsMetaConnection(queryable, '-1'), true);
});
