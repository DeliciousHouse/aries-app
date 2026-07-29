/**
 * AA-163 — the pre-execution plan gate.
 *
 * The gate's whole risk profile is asymmetric: a wrong DENY blocks a paying
 * customer's work, a wrong ALLOW costs a few tasks of overage. So most of these
 * cases pin the fail-open paths, and only one pins a denial:
 *   - flag OFF is a pure pass-through with ZERO queries;
 *   - system/userless work is never billed to anyone;
 *   - a NULL allowance is unlimited, not a 0 ceiling;
 *   - no rollup watermark (metering off) allows — "0 used" would be an artifact;
 *   - an unreported metric allows — this is the tokens case until Hermes emits
 *     usage, and it is what keeps flipping the metric from denying everything;
 *   - a DB error on either lookup allows;
 *   - over a KNOWN ceiling denies, with the typed code the route maps to 402.
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertUsageWithinPlan,
  billingPeriodStart,
  enforcePlanLimitOrThrow,
} from '@/backend/billing/usage-entitlement';

type Call = { sql: string; params: unknown[] };

const ON = { ARIES_PLAN_ENFORCEMENT_ENABLED: '1' };
const OFF = {} as Record<string, string | undefined>;

function fakeDb(responder?: (sql: string) => { rows?: unknown[] } | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder?.(sql);
      return { rows: res?.rows ?? [], rowCount: res?.rows?.length ?? 0 };
    },
  };
}

/** A company on `tier` with `tasksUsed` tasks recorded this period. */
function db({
  tier = 'starter',
  taskAllowance = 1000,
  taskOverride = null as number | string | null,
  tasksUsed = 0 as number | string | null,
  tokensUsed = null as number | string | null,
  metered = true,
  subscriptionRow = true,
  credits = 0 as number | string,
}) {
  return fakeDb((sql) => {
    // AA-164: purchased credits stack on top of the monthly allowance.
    if (sql.includes('FROM company_credit_ledger')) {
      return { rows: [{ balance: credits }] };
    }
    if (sql.includes('FROM company_subscriptions')) {
      return {
        rows: subscriptionRow
          ? [
              {
                tier_key: tier,
                monthly_task_allowance_override: taskOverride,
                monthly_token_allowance_override: null,
                monthly_task_allowance: taskAllowance,
                monthly_token_allowance: 2000000,
              },
            ]
          : [],
      };
    }
    if (sql.includes('rolled_through')) {
      return {
        rows: [
          {
            rolled_through: metered ? '2026-07-28T10:00:00.000Z' : null,
            tasks_used: tasksUsed,
            tokens_used: tokensUsed,
          },
        ],
      };
    }
    return undefined;
  });
}

test('flag OFF is a pure pass-through with no DB round-trip', async () => {
  const handle = db({});

  const decision = await assertUsageWithinPlan(7, { db: handle, env: OFF });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'enforcement_disabled');
  assert.deepEqual(handle.calls, []);
});

test('system and userless work is never gated', async () => {
  for (const id of [null, undefined, '', 'system', 0]) {
    const handle = db({});
    const decision = await assertUsageWithinPlan(id, { db: handle, env: ON });
    assert.equal(decision.allowed, true, `expected allow for ${JSON.stringify(id)}`);
    assert.equal(decision.allowed && decision.reason, 'not_company_scoped');
    assert.deepEqual(handle.calls, [], 'no query for non-company work');
  }
});

test('a company over a known ceiling is denied with the typed code', async () => {
  const handle = db({ taskAllowance: 1000, tasksUsed: 1000 });

  const decision = await assertUsageWithinPlan('7', { db: handle, env: ON });

  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.code, 'plan_limit_exceeded');
  assert.equal(decision.tier, 'starter');
  assert.equal(decision.metric, 'tasks');
  assert.equal(decision.used, 1000);
  assert.equal(decision.allowance, 1000);
});

test('a company under its ceiling is allowed and reports its consumption', async () => {
  const handle = db({ taskAllowance: 1000, tasksUsed: '999' }); // BIGINT arrives as a string

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'within_allowance');
  assert.equal(decision.allowed && decision.used, 999);
});

test('a per-company override beats the tier card (the Custom/Enterprise path)', async () => {
  // Enterprise is unlimited by default; the negotiated ceiling comes from the
  // override, and it must be what the gate enforces.
  const handle = db({
    tier: 'enterprise',
    taskAllowance: null as unknown as number,
    taskOverride: 50,
    tasksUsed: 50,
  });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, false);
  assert.equal(!decision.allowed && decision.allowance, 50);
  assert.equal(!decision.allowed && decision.tier, 'enterprise');
});

test('an unlimited allowance allows without reading usage at all', async () => {
  const handle = db({ tier: 'enterprise', taskAllowance: null as unknown as number });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'unlimited_allowance');
  assert.equal(handle.calls.filter((c) => c.sql.includes('rolled_through')).length, 0);
});

test('a company with no subscription row is covered by the entry tier', async () => {
  // A workspace created after the backfill must still be gated, without waiting
  // for a container restart to give it a row.
  const handle = db({ subscriptionRow: false, tasksUsed: 5000 });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, false);
  assert.equal(!decision.allowed && decision.tier, 'starter');
});

test('no rollup watermark means usage is not metered — allow, never deny on an artifact', async () => {
  // The rollup worker ships default OFF, so the aggregates are empty. Reading
  // "0 used" there would enforce against nothing; reading it as unmetered is the
  // honest interpretation.
  const handle = db({ metered: false, tasksUsed: 0 });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'usage_not_metered');
});

test('the tokens metric is inert while Hermes reports no usage', async () => {
  // Every AI row has NULL tokens today, so the sum is NULL. Flipping the metric
  // early must not deny every request — it must simply not enforce yet.
  const handle = db({ tokensUsed: null, tasksUsed: 99999 });

  const decision = await assertUsageWithinPlan(7, {
    db: handle,
    env: { ...ON, ARIES_PLAN_ENFORCEMENT_METRIC: 'tokens' },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'usage_not_metered');
  assert.equal(decision.allowed && decision.metric, 'tokens');
});

test('the tokens metric enforces once usage is reported', async () => {
  const handle = db({ tokensUsed: 2000000 });

  const decision = await assertUsageWithinPlan(7, {
    db: handle,
    env: { ...ON, ARIES_PLAN_ENFORCEMENT_METRIC: 'tokens' },
  });

  assert.equal(decision.allowed, false);
  assert.equal(!decision.allowed && decision.allowance, 2000000);
});

test('an unrecognized metric falls back rather than failing a job create', async () => {
  const handle = db({ taskAllowance: 1000, tasksUsed: 1000 });

  const decision = await assertUsageWithinPlan(7, {
    db: handle,
    env: { ...ON, ARIES_PLAN_ENFORCEMENT_METRIC: 'bananas' },
  });

  assert.equal(decision.metric, 'tasks');
  assert.equal(decision.allowed, false);
});

test('a subscription lookup failure allows', async () => {
  const handle = fakeDb((sql) => {
    if (sql.includes('FROM company_subscriptions')) throw new Error('connection terminated');
    return undefined;
  });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'subscription_unavailable');
});

test('a usage lookup failure allows', async () => {
  const handle = fakeDb((sql) => {
    if (sql.includes('FROM company_subscriptions')) {
      return {
        rows: [
          {
            tier_key: 'starter',
            monthly_task_allowance_override: null,
            monthly_token_allowance_override: null,
            monthly_task_allowance: 1000,
            monthly_token_allowance: 2000000,
          },
        ],
      };
    }
    if (sql.includes('FROM company_credit_ledger')) return { rows: [{ balance: '0' }] };
    throw new Error('deadlock detected');
  });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'usage_unavailable');
});

test('consumption is scoped to the current UTC calendar month', () => {
  assert.equal(billingPeriodStart(new Date('2026-07-28T23:59:59.000Z')), '2026-07-01');
  assert.equal(billingPeriodStart(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01');
  assert.equal(billingPeriodStart(new Date('2026-12-31T12:00:00.000Z')), '2026-12-01');
});

test('the period start is what the usage query filters on', async () => {
  const handle = db({});

  await assertUsageWithinPlan(7, {
    db: handle,
    env: ON,
    now: () => new Date('2026-07-28T10:00:00.000Z'),
  });

  const usageCall = handle.calls.find((c) => c.sql.includes('rolled_through'));
  assert.deepEqual(usageCall?.params, [7, '2026-07-01']);
});

test('purchased credits stack on top of the monthly allowance (AA-164)', async () => {
  // Over the included 1000, but they bought 500 more — this must go through, or
  // we took their money and kept the door shut.
  const topped = db({ taskAllowance: 1000, tasksUsed: 1200, credits: '500' });
  const allowed = await assertUsageWithinPlan(7, { db: topped, env: ON });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.allowed && allowed.allowance, 1500);

  // Credits spent too: back to denied.
  const spent = db({ taskAllowance: 1000, tasksUsed: 1500, credits: '500' });
  const denied = await assertUsageWithinPlan(7, { db: spent, env: ON });
  assert.equal(denied.allowed, false);
  assert.equal(!denied.allowed && denied.allowance, 1500);
});

test('an unreadable credit balance allows rather than denying a paying customer', async () => {
  const handle = fakeDb((sql) => {
    if (sql.includes('FROM company_subscriptions')) {
      return {
        rows: [
          {
            tier_key: 'starter',
            monthly_task_allowance_override: null,
            monthly_token_allowance_override: null,
            monthly_task_allowance: 1000,
            monthly_token_allowance: 2000000,
          },
        ],
      };
    }
    if (sql.includes('FROM company_credit_ledger')) throw new Error('connection terminated');
    return undefined;
  });

  const decision = await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.reason, 'credits_unavailable');
});

test('an unlimited tier never reads the credit ledger', async () => {
  const handle = db({ tier: 'enterprise', taskAllowance: null as unknown as number });

  await assertUsageWithinPlan(7, { db: handle, env: ON });

  assert.equal(handle.calls.filter((c) => c.sql.includes('company_credit_ledger')).length, 0);
});

test('the throwing wrapper surfaces the code the route maps to 402', async () => {
  const denied = db({ taskAllowance: 1000, tasksUsed: 1200 });
  await assert.rejects(
    () => enforcePlanLimitOrThrow(7, { db: denied, env: ON }),
    /^Error: plan_limit_exceeded:starter:tasks$/,
  );

  // And it returns the decision (rather than throwing) when work is permitted.
  const allowed = db({ taskAllowance: 1000, tasksUsed: 1 });
  const decision = await enforcePlanLimitOrThrow(7, { db: allowed, env: ON });
  assert.equal(decision.allowed, true);
});
