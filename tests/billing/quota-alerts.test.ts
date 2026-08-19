/**
 * AA-164 — 80% / 95% quota-exhaustion alerts.
 *
 * The sweep runs on the hourly rollup tick, so the dominant risk is emailing a
 * customer every hour for a month. These tests weight that accordingly:
 *   - the dedupe row is CLAIMED BEFORE the send, so a crash costs one alert
 *     instead of causing an hourly re-send;
 *   - an already-claimed threshold sends nothing;
 *   - unmetered / unlimited / unreported companies are skipped entirely;
 *   - a company with no admins is left UNCLAIMED, so the alert can still land
 *     once someone is made an admin;
 *   - one company's failure never stops the sweep.
 *
 * Fully in-memory: db and the email transport are both injected.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUOTA_ALERT_THRESHOLDS,
  runQuotaThresholdAlerts,
  SELECT_ALERT_CANDIDATES_SQL,
  type Queryable,
} from '@/backend/billing/quota-alerts';

type Call = { sql: string; params: unknown[] };
type Sent = { to: string; threshold: number; percentUsed: number; workspaceName: string };

const ON = { ARIES_QUOTA_ALERTS_ENABLED: '1', APP_BASE_URL: 'https://aries.example.com' };

type Candidate = {
  company_id: number;
  tier_key?: string;
  monthly_task_allowance?: number | null;
  monthly_task_allowance_override?: number | null;
  monthly_token_allowance?: number | null;
  monthly_token_allowance_override?: number | null;
  company_name?: string | null;
  tasks_used?: string | number | null;
  tokens_used?: string | number | null;
  credits?: string | number;
};

function harness(options: {
  candidates: Candidate[];
  metered?: boolean;
  admins?: string[];
  /** Thresholds already alerted for, as `${companyId}:${threshold}`. */
  alreadySent?: Set<string>;
  failOnClaim?: boolean;
}) {
  const calls: Call[] = [];
  const sent: Sent[] = [];
  const alreadySent = options.alreadySent ?? new Set<string>();
  const admins = options.admins ?? ['admin@acme.test'];

  const db: Queryable = {
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      calls.push({ sql, params: p });
      if (sql.includes('FROM usage_rollup_state')) {
        return {
          rows: [{ rolled_through: options.metered === false ? null : '2026-07-28T10:00:00Z' }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM company_subscriptions')) {
        return {
          rows: options.candidates.map((c) => ({
            tier_key: 'starter',
            monthly_task_allowance: 1000,
            monthly_task_allowance_override: null,
            monthly_token_allowance: 2000000,
            monthly_token_allowance_override: null,
            company_name: 'Acme',
            tokens_used: null,
            credits: '0',
            ...c,
          })),
          rowCount: options.candidates.length,
        };
      }
      if (sql.includes('FROM organization_memberships')) {
        return { rows: admins.map((email) => ({ email })), rowCount: admins.length };
      }
      if (sql.includes('INSERT INTO usage_alert_notifications')) {
        if (options.failOnClaim) throw new Error('deadlock detected');
        const key = `${p[0]}:${p[2]}`;
        if (alreadySent.has(key)) return { rows: [], rowCount: 0 };
        alreadySent.add(key);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const send = async (params: {
    to: string;
    threshold: number;
    percentUsed: number;
    workspaceName: string;
  }) => {
    sent.push({
      to: params.to,
      threshold: params.threshold,
      percentUsed: params.percentUsed,
      workspaceName: params.workspaceName,
    });
  };

  return { db, calls, sent, send: send as never };
}

test('the thresholds are exactly the two the AC names', () => {
  assert.deepEqual([...QUOTA_ALERT_THRESHOLDS], [80, 95]);
});

test('quota alerts exclude non-production tenants unless explicitly included', async () => {
  assert.match(SELECT_ALERT_CANDIDATES_SQL, /JOIN organizations o ON o\.id = s\.company_id/i);
  assert.match(SELECT_ALERT_CANDIDATES_SQL, /o\.kind\s*=\s*ANY\(\$2::text\[\]\)/i);

  const defaultKinds = harness({ candidates: [] });
  await runQuotaThresholdAlerts(defaultKinds.db, { env: ON, send: defaultKinds.send });
  const defaultQuery = defaultKinds.calls.find((call) => call.sql.includes('FROM company_subscriptions'));
  assert.deepEqual(defaultQuery?.params[1], ['production']);

  const includedTest = harness({ candidates: [] });
  await runQuotaThresholdAlerts(includedTest.db, {
    env: ON,
    send: includedTest.send,
    tenantKinds: ['production', 'test'],
  });
  const includedQuery = includedTest.calls.find((call) => call.sql.includes('FROM company_subscriptions'));
  assert.deepEqual(includedQuery?.params[1], ['production', 'test']);
});

test('flag OFF sends nothing and touches no table', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '999' }] });

  const report = await runQuotaThresholdAlerts(h.db, { env: {}, send: h.send });

  assert.equal(report.skipped, true);
  assert.equal(report.skippedReason, 'disabled');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
});

test('a company crossing 80% is emailed once, with its real percentage', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '850' }] });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.alertsSent, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].threshold, 80);
  assert.equal(h.sent[0].percentUsed, 85, 'the email states the real figure, not the threshold');
  assert.equal(h.sent[0].to, 'admin@acme.test');
});

test('crossing both thresholds at once sends both, and every admin is told', async () => {
  const h = harness({
    candidates: [{ company_id: 1, tasks_used: '990' }],
    admins: ['a@acme.test', 'b@acme.test'],
  });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.alertsSent, 4, '2 thresholds x 2 admins');
  assert.deepEqual(
    h.sent.map((s) => s.threshold),
    [80, 80, 95, 95],
  );
});

test('a re-tick does not re-email — the dedupe row is the whole point', async () => {
  const shared = new Set<string>();
  const first = harness({ candidates: [{ company_id: 1, tasks_used: '850' }], alreadySent: shared });
  await runQuotaThresholdAlerts(first.db, { env: ON, send: first.send });
  assert.equal(first.sent.length, 1);

  // Same period, same threshold, an hour later.
  const second = harness({
    candidates: [{ company_id: 1, tasks_used: '860' }],
    alreadySent: shared,
  });
  const report = await runQuotaThresholdAlerts(second.db, { env: ON, send: second.send });

  assert.equal(second.sent.length, 0);
  assert.equal(report.alertsDeduped, 1);
});

test('the dedupe row is claimed BEFORE the email is sent', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '850' }] });
  const order: string[] = [];
  const db: Queryable = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO usage_alert_notifications')) order.push('claim');
      return h.db.query(sql, params);
    },
  };

  await runQuotaThresholdAlerts(db, {
    env: ON,
    send: (async () => {
      order.push('send');
    }) as never,
  });

  // Claiming afterwards would re-send on every hourly tick until one attempt
  // finally succeeded; claiming first costs at most one lost alert.
  assert.deepEqual(order, ['claim', 'send']);
});

test('unmetered usage skips the sweep entirely', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '999' }], metered: false });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.skipped, true);
  assert.equal(report.skippedReason, 'usage_not_metered');
  assert.deepEqual(h.sent, []);
});

test('unlimited plans and unreported metrics are skipped, not alerted', async () => {
  const h = harness({
    candidates: [
      { company_id: 1, tier_key: 'enterprise', monthly_task_allowance: null, tasks_used: '99999' },
      { company_id: 2, tasks_used: null },
    ],
  });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.companiesChecked, 2);
  assert.equal(report.alertsSent, 0);
});

test('a company below 80% is left alone', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '700' }] });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.alertsSent, 0);
  assert.equal(
    h.calls.filter((c) => c.sql.includes('INSERT INTO usage_alert_notifications')).length,
    0,
  );
});

test('the trigger uses the same rounded percentage the dashboard shows', async () => {
  // 79.9% displays as 80%, so it alerts at 80%. Triggering off the unrounded
  // value instead would email a customer "80%" while their dashboard read 79% —
  // the two numbers must be the same number.
  const boundary = harness({ candidates: [{ company_id: 1, tasks_used: '799' }] });
  const crossed = await runQuotaThresholdAlerts(boundary.db, { env: ON, send: boundary.send });
  assert.equal(crossed.alertsSent, 1);
  assert.equal(boundary.sent[0].percentUsed, 80);

  // 79.4% displays as 79% and does not.
  const below = harness({ candidates: [{ company_id: 1, tasks_used: '794' }] });
  const held = await runQuotaThresholdAlerts(below.db, { env: ON, send: below.send });
  assert.equal(held.alertsSent, 0);
});

test('purchased credits raise the bar the alert fires at', async () => {
  // 850 of an included 1000 would be 85% and would alert; with 1000 purchased
  // credits it is 42% and must not.
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '850', credits: '1000' }] });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.alertsSent, 0);
});

test('a company with no admins is left unclaimed so the alert can still land later', async () => {
  const h = harness({ candidates: [{ company_id: 1, tasks_used: '850' }], admins: [] });

  const report = await runQuotaThresholdAlerts(h.db, { env: ON, send: h.send });

  assert.equal(report.alertsSent, 0);
  assert.equal(
    h.calls.filter((c) => c.sql.includes('INSERT INTO usage_alert_notifications')).length,
    0,
    'claiming with nobody to email would burn the alert for the whole period',
  );
});

test('one company failing does not stop the others', async () => {
  const h = harness({
    candidates: [
      { company_id: 1, tasks_used: '850' },
      { company_id: 2, tasks_used: '900' },
    ],
  });
  let claims = 0;
  const db: Queryable = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO usage_alert_notifications')) {
        claims += 1;
        if (claims === 1) throw new Error('deadlock detected');
      }
      return h.db.query(sql, params);
    },
  };

  const report = await runQuotaThresholdAlerts(db, { env: ON, send: h.send });

  assert.equal(report.errors, 1);
  assert.equal(report.companiesChecked, 2);
  assert.equal(report.alertsSent, 1, 'the second company was still alerted');
});
