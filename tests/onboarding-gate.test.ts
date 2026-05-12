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
  assert.equal(
    connectionCounterCalled,
    false,
    'connection counter should be skipped when profile is incomplete',
  );
});

test('evaluateOnboardingGate redirects to Meta connect page when profile is complete but no Meta/IG connections exist', async () => {
  // Profile-complete users must NOT be sent back to /onboarding/start — that
  // makes them redo step 1 forever in a loop. Send them to the Meta connect
  // page so the next step is the next step.
  const decision = await evaluateOnboardingGate({
    client: makeQueryable(() => ({ rows: [], rowCount: 0 })),
    tenantId: '42',
    profileIncompleteResolver: async () => false,
    connectionCounter: async () => 0,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'meta_not_connected');
  assert.equal(decision.redirectTo, META_CONNECT_REDIRECT_DESTINATION);
  // Pin the literal value so a future rename has to update the literal here too.
  // The OAuth provider entrypoint that renders the connect screen with no
  // required query params — unlike /onboarding/connect/meta/select-page which
  // requires `state` and bounces to /onboarding/start without it.
  assert.equal(decision.redirectTo, '/oauth/connect/facebook');
  assert.notEqual(decision.redirectTo, GATE_REDIRECT_DESTINATION);
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
