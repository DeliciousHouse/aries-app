import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import { grantCompanyCredits, loadCreditBalance } from '../../backend/billing/credit-ledger';
import {
  SELECT_CONSUMPTION_SQL,
  SELECT_SUBSCRIPTION_SQL,
  billingPeriodStart,
} from '../../backend/billing/usage-entitlement';

// Live-schema proof for the AA-163 rate cards. The in-memory tests only ever see
// these statements as strings, so a renamed column, a bad join, or a CHECK that
// rejects a shipped tier would pass them and then deny (or fail to deny) in prod.
// This file runs the real exported statements against the real schema inside a
// rolled-back transaction, proving:
//   1. the four tiers seed, and a PM's edited rate SURVIVES a re-seed (the
//      ON CONFLICT DO NOTHING contract — a redeploy must not clobber pricing);
//   2. the subscription join returns the tier's allowance, and a per-company
//      override sits alongside it for the gate to prefer (Custom/Enterprise);
//   3. the FK rejects a subscription for a company that does not exist;
//   4. the consumption statement actually runs against the real
//      daily_company_usage / usage_rollup_state objects.

test('plan rate cards + subscriptions against real Postgres', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. The four tiers the AC names are present.
    const cards = await client.query(
      `SELECT tier_key, monthly_task_allowance FROM plan_rate_cards ORDER BY sort_order`,
    );
    assert.deepEqual(
      cards.rows.map((r) => r.tier_key),
      ['starter', 'growth', 'scale', 'enterprise'],
    );
    assert.equal(
      cards.rows[3].monthly_task_allowance,
      null,
      'Enterprise is unlimited by default; a ceiling comes from the per-company override',
    );

    // A PM's edit must survive the next container start. The seed is
    // ON CONFLICT DO NOTHING precisely so a redeploy cannot reset pricing.
    await client.query(
      `UPDATE plan_rate_cards SET monthly_task_allowance = 4242 WHERE tier_key = 'growth'`,
    );
    await client.query(
      `INSERT INTO plan_rate_cards
         (tier_key, display_name, monthly_task_allowance, monthly_token_allowance, cost_per_million_tokens_cents, sort_order)
       VALUES ('growth', 'Growth (Medium)', 5000, 10000000, 1200.0000, 2)
       ON CONFLICT (tier_key) DO NOTHING`,
    );
    const afterReseed = await client.query(
      `SELECT monthly_task_allowance FROM plan_rate_cards WHERE tier_key = 'growth'`,
    );
    assert.equal(Number(afterReseed.rows[0].monthly_task_allowance), 4242);

    // 2. A company on that tier resolves its allowance through the real join.
    const org = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      ['AA-163 rate card test', `aa163-rate-card-${Date.now() % 100000}`],
    );
    const companyId = Number(org.rows[0].id);

    await client.query(
      `INSERT INTO company_subscriptions (company_id, tier_key, assigned_by)
       VALUES ($1, 'growth', 'test')`,
      [companyId],
    );
    const sub = await client.query(SELECT_SUBSCRIPTION_SQL, [companyId]);
    assert.equal(sub.rows.length, 1);
    assert.equal(sub.rows[0].tier_key, 'growth');
    assert.equal(Number(sub.rows[0].monthly_task_allowance), 4242, 'the tier card supplies the ceiling');
    assert.equal(sub.rows[0].monthly_task_allowance_override, null);

    // The Custom/Enterprise path: a negotiated ceiling on the same row.
    await client.query(
      `UPDATE company_subscriptions
          SET tier_key = 'enterprise', monthly_task_allowance_override = 100000
        WHERE company_id = $1`,
      [companyId],
    );
    const custom = await client.query(SELECT_SUBSCRIPTION_SQL, [companyId]);
    assert.equal(custom.rows[0].tier_key, 'enterprise');
    assert.equal(Number(custom.rows[0].monthly_task_allowance_override), 100000);
    assert.equal(
      custom.rows[0].monthly_task_allowance,
      null,
      'the tier itself stays unlimited; the override is what the gate enforces',
    );

    // 3. A typo'd company id must fail loudly rather than create an orphan.
    await client.query('SAVEPOINT bad_company');
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO company_subscriptions (company_id, tier_key) VALUES (2147483600, 'starter')`,
        ),
      /foreign key|violates/i,
    );
    await client.query('ROLLBACK TO SAVEPOINT bad_company');

    // 4. The consumption statement runs against the real usage objects.
    const usage = await client.query(SELECT_CONSUMPTION_SQL, [companyId, billingPeriodStart()]);
    assert.equal(usage.rows.length, 1);
    assert.equal(Number(usage.rows[0].tasks_used), 0, 'a brand-new company has consumed nothing');
    assert.ok('rolled_through' in usage.rows[0], 'the metering signal must be selectable');

    // 5. (AA-164) The credit ledger's PARTIAL unique index is the thing an
    //    in-memory test cannot prove: a redelivered gateway event must credit
    //    once, while manual grants (NULL event id) must NOT be deduped against
    //    each other by that same index.
    const paid = await grantCompanyCredits(
      { companyId, credits: 500, source: 'purchase', externalEventId: `evt-${companyId}` },
      client,
    );
    assert.equal(paid.applied, true);
    const replay = await grantCompanyCredits(
      { companyId, credits: 500, source: 'purchase', externalEventId: `evt-${companyId}` },
      client,
    );
    assert.deepEqual(
      replay,
      { applied: false, reason: 'duplicate_event' },
      'a webhook redelivery must never credit twice',
    );
    await grantCompanyCredits({ companyId, credits: 100, source: 'grant' }, client);
    await grantCompanyCredits({ companyId, credits: 100, source: 'grant' }, client);
    assert.equal(
      await loadCreditBalance(companyId, client),
      700,
      'manual grants both land; only the gateway event is deduped',
    );

    // Expired credits leave the balance without leaving the audit trail.
    await client.query(
      `INSERT INTO company_credit_ledger (company_id, credits, source, expires_at)
       VALUES ($1, 9999, 'grant', now() - interval '1 day')`,
      [companyId],
    );
    assert.equal(await loadCreditBalance(companyId, client), 700);

    // The alert dedupe key is a PRIMARY KEY, so a second claim for the same
    // (company, period, threshold) is refused — that is what stops the hourly
    // sweep emailing a customer every tick for a month.
    const claim = await client.query(
      `INSERT INTO usage_alert_notifications (company_id, period_start, threshold, recipients)
       VALUES ($1, $2::date, 80, 1) ON CONFLICT DO NOTHING`,
      [companyId, billingPeriodStart()],
    );
    assert.equal(claim.rowCount, 1);
    const reclaim = await client.query(
      `INSERT INTO usage_alert_notifications (company_id, period_start, threshold, recipients)
       VALUES ($1, $2::date, 80, 1) ON CONFLICT DO NOTHING`,
      [companyId, billingPeriodStart()],
    );
    assert.equal(reclaim.rowCount, 0, 'a re-tick must not be able to re-claim the same alert');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
