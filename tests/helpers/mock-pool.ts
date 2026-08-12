/**
 * tests/helpers/mock-pool.ts
 *
 * A scripted stand-in for the shared pg pool, so a route handler can be driven
 * to a real 200 without Postgres.
 *
 * The insights read handlers acquire a pooled client (`pool.connect()`) and then
 * issue several queries through it, so patching `pool.query` alone — the idiom
 * tests/insights-narrative-connection-error.test.ts uses for the one call that
 * bypasses the client — is not enough. This patches both.
 *
 * Queries are matched by a regex against the SQL text rather than by call order.
 * Order-based scripting breaks the moment a handler adds a lookup (the timezone
 * resolve, say), and it silently mis-feeds every later query when it does, which
 * is exactly the kind of test that passes while asserting nothing true.
 *
 * Every call is RECORDED. That matters more than the canned rows: asserting a
 * handler returned the right shape only proves it read the fixture, whereas the
 * recorded params prove `tenant_id` came from the resolved context and was bound
 * as a parameter rather than interpolated.
 */

import pool from '../../lib/db';

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

export interface QueryRule {
  /** Matched against the SQL text. First matching rule wins. */
  match: RegExp;
  /** Rows to return, or a function of the bound params. */
  rows: unknown[] | ((params: unknown[]) => unknown[]);
  /** When set, the query rejects with this instead of returning rows. */
  throws?: Error;
}

export interface MockPool {
  /** Every query issued, in order, through either the client or the pool. */
  readonly calls: RecordedQuery[];
  /** Queries whose SQL matches — the usual way to assert on one statement. */
  matching(re: RegExp): RecordedQuery[];
  /** How many clients were checked out. */
  readonly connectCount: number;
  /** How many were released. A leak shows up as connectCount > releaseCount. */
  readonly releaseCount: number;
  /** Restore the real pool. Always call from a `finally`. */
  restore(): void;
}

/**
 * Build the query router used by both the standalone client and the patched
 * pool. Unmatched SQL throws by design: a silent empty result would let a
 * handler whose query the test forgot to script still "pass" — reading `rows[0]`
 * of nothing and reporting zeros, which is precisely the failure mode these
 * suites exist to catch.
 */
function makeRunner(rules: QueryRule[], calls: RecordedQuery[]) {
  return async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rule = rules.find((r) => r.match.test(sql));
    if (!rule) {
      throw new Error(
        `mock-pool: no rule matched this query:\n${sql.trim().slice(0, 400)}`,
      );
    }
    if (rule.throws) throw rule.throws;
    return { rows: typeof rule.rows === 'function' ? rule.rows(params) : rule.rows };
  };
}

/**
 * A scripted PoolClient for the builders that are HANDED a client rather than
 * acquiring one (AA-122: a builder must not check out a second connection). No
 * pool patching is involved — the client is simply passed in.
 */
export function scriptedClient(rules: QueryRule[]) {
  const calls: RecordedQuery[] = [];
  const run = makeRunner(rules, calls);
  return {
    calls,
    matching: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
    client: { query: (sql: string, params?: unknown[]) => run(sql, params) },
  };
}

/**
 * Install a scripted pool for the duration of a test.
 */
export function installMockPool(rules: QueryRule[]): MockPool {
  const calls: RecordedQuery[] = [];
  let connectCount = 0;
  let releaseCount = 0;

  const run = makeRunner(rules, calls);

  const originalConnect = pool.connect;
  const originalQuery = pool.query;

  (pool as unknown as { connect: unknown }).connect = async () => {
    connectCount += 1;
    return {
      query: (sql: string, params?: unknown[]) => run(sql, params),
      release: () => {
        releaseCount += 1;
      },
    };
  };
  (pool as unknown as { query: unknown }).query = (sql: string, params?: unknown[]) =>
    run(sql, params);

  return {
    calls,
    matching: (re: RegExp) => calls.filter((c) => re.test(c.sql)),
    get connectCount() {
      return connectCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    restore() {
      (pool as unknown as { connect: unknown }).connect = originalConnect;
      (pool as unknown as { query: unknown }).query = originalQuery;
    },
  };
}

/**
 * Run `fn` against a scripted pool and always restore, even when it throws.
 */
export async function withMockPool<T>(
  rules: QueryRule[],
  fn: (mock: MockPool) => Promise<T>,
): Promise<T> {
  const mock = installMockPool(rules);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

/**
 * The timezone lookup every insights builder performs first. Scripted here so
 * each suite does not restate it; `null` resolves to the documented default.
 */
export const TIMEZONE_RULE: QueryRule = {
  match: /FROM business_profiles/i,
  rows: [{ timezone: null }],
};

/** A tenant-context loader that skips auth entirely (no session, no DB). */
export function stubTenantLoader(tenantId: string | number = 7) {
  return async () => ({
    tenantId: String(tenantId),
    tenantSlug: 'mock-tenant',
    role: 'tenant_admin',
    userId: '1',
  });
}
