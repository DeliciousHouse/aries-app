/**
 * AA-164 — the quota summary behind the dashboard card.
 *
 * The headline contract is honesty: this is the number a customer sees, so it
 * must never be confidently wrong.
 *   - unmetered usage reports metered:false with NULL figures, NOT "0% used";
 *   - an unlimited plan has no percentage at all (no division by null);
 *   - a zero ceiling doesn't divide by zero;
 *   - an overage reports its true percentage rather than being clamped to 100;
 *   - purchased credits raise the denominator, so the percentage a customer sees
 *     matches the ceiling they are actually cut off at.
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeQuotaFigures, loadQuotaSummary } from '@/backend/billing/quota-summary';

function fakeDb(rows: {
  tier?: string;
  taskAllowance?: number | null;
  taskOverride?: number | null;
  credits?: string | number;
  tasksUsed?: string | number | null;
  metered?: boolean;
  subscriptionRow?: boolean;
}) {
  const {
    tier = 'starter',
    taskAllowance = 1000,
    taskOverride = null,
    credits = '0',
    tasksUsed = '0',
    metered = true,
    subscriptionRow = true,
  } = rows;
  return {
    query: async (sql: string) => {
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
          rowCount: subscriptionRow ? 1 : 0,
        };
      }
      if (sql.includes('FROM company_credit_ledger')) {
        return { rows: [{ balance: credits }], rowCount: 1 };
      }
      return {
        rows: [
          {
            rolled_through: metered ? '2026-07-28T10:00:00.000Z' : null,
            tasks_used: tasksUsed,
            tokens_used: null,
          },
        ],
        rowCount: 1,
      };
    },
  };
}

const NOW = () => new Date('2026-07-28T12:00:00.000Z');

test('percentage math: the pure cases', () => {
  assert.deepEqual(computeQuotaFigures(250, 1000), { remaining: 750, percentUsed: 25 });
  assert.deepEqual(computeQuotaFigures(1000, 1000), { remaining: 0, percentUsed: 100 });
  // An overage reports the truth. Clamping to 100 would hide the overshoot from
  // the person paying for it.
  assert.deepEqual(computeQuotaFigures(1040, 1000), { remaining: 0, percentUsed: 104 });
  // Unmetered and unlimited both mean "there is no percentage", not zero.
  assert.deepEqual(computeQuotaFigures(null, 1000), { remaining: null, percentUsed: null });
  assert.deepEqual(computeQuotaFigures(250, null), { remaining: null, percentUsed: null });
  // A zero ceiling must not divide by zero.
  assert.deepEqual(computeQuotaFigures(0, 0), { remaining: 0, percentUsed: 0 });
  assert.deepEqual(computeQuotaFigures(5, 0), { remaining: 0, percentUsed: 100 });
});

test('a metered company reports its consumption and percentage', async () => {
  const summary = await loadQuotaSummary(7, { db: fakeDb({ tasksUsed: '800' }), now: NOW });

  assert.equal(summary.metered, true);
  assert.equal(summary.metric, 'tasks');
  assert.equal(summary.tier, 'starter');
  assert.equal(summary.includedAllowance, 1000);
  assert.equal(summary.totalAllowance, 1000);
  assert.equal(summary.used, 800);
  assert.equal(summary.remaining, 200);
  assert.equal(summary.percentUsed, 80);
  assert.equal(summary.periodStart, '2026-07-01');
});

test('purchased credits raise the ceiling the percentage is measured against', async () => {
  const summary = await loadQuotaSummary(7, {
    db: fakeDb({ tasksUsed: '1000', credits: '1000' }),
    now: NOW,
  });

  assert.equal(summary.purchasedCredits, 1000);
  assert.equal(summary.totalAllowance, 2000);
  // Without the credits this would read 100% and look like a dead stop.
  assert.equal(summary.percentUsed, 50);
  assert.equal(summary.remaining, 1000);
});

test('an unmetered workspace reports NULL figures, never a confident zero', async () => {
  const summary = await loadQuotaSummary(7, {
    db: fakeDb({ metered: false, tasksUsed: '0' }),
    now: NOW,
  });

  assert.equal(summary.metered, false);
  assert.equal(summary.used, null);
  assert.equal(summary.percentUsed, null, '0% would be a wrong number, not a missing one');
  assert.equal(summary.remaining, null);
  // The plan itself is still known and worth showing.
  assert.equal(summary.includedAllowance, 1000);
  assert.equal(summary.tierLabel, 'Starter (Small)');
});

test('an unlimited plan has no percentage', async () => {
  const summary = await loadQuotaSummary(7, {
    db: fakeDb({ tier: 'enterprise', taskAllowance: null, tasksUsed: '5000' }),
    now: NOW,
  });

  assert.equal(summary.totalAllowance, null);
  assert.equal(summary.percentUsed, null);
  assert.equal(summary.used, 5000, 'consumption is still worth showing');
});

test('a per-company override is the ceiling shown, matching what the gate enforces', async () => {
  const summary = await loadQuotaSummary(7, {
    db: fakeDb({ tier: 'enterprise', taskAllowance: null, taskOverride: 400, tasksUsed: '380' }),
    now: NOW,
  });

  assert.equal(summary.includedAllowance, 400);
  assert.equal(summary.percentUsed, 95);
});

test('a company with no subscription row is summarized on the entry tier', async () => {
  const summary = await loadQuotaSummary(7, {
    db: fakeDb({ subscriptionRow: false, tasksUsed: '500' }),
    now: NOW,
  });

  assert.equal(summary.tier, 'starter');
  assert.equal(summary.includedAllowance, 1000);
  assert.equal(summary.percentUsed, 50);
});
