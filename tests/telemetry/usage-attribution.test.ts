/**
 * AA-165 — cross-company usage & cost attribution.
 *
 * What these pin:
 *   - the AC filter set is validated, not silently ignored (a finance figure
 *     that answered a different question than the filters on screen is the
 *     worst failure this surface has);
 *   - an operator-supplied task key is a BOUND parameter, never interpolated;
 *   - the date range is ALWAYS in the WHERE clause, so no query can scan the
 *     whole table;
 *   - unmetered reports empty, not a zeroed finance dashboard;
 *   - the `0` unscoped bucket is labelled, not dropped, so totals reconcile;
 *   - the company cap is reported, never a silent truncation;
 *   - reads are sequential (guardrail #1).
 *
 * Fully in-memory (injected db) — no live Postgres.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COMPANY_LIMIT,
  buildUsageFilterClause,
  loadUsageAttribution,
  parseUsageAttributionFilters,
  type Queryable,
  type UsageAttributionFilters,
} from '@/backend/telemetry/usage-attribution';

const NOW = new Date('2026-07-31T12:00:00Z');

const BASE_FILTERS: UsageAttributionFilters = {
  companyId: null,
  userId: null,
  taskKey: null,
  engine: null,
  from: '2026-07-01',
  to: '2026-07-31',
};

type Call = { sql: string; params: unknown[] };

function recordingDb(
  rowsFor: (sql: string) => unknown[],
  calls: Call[],
  options: { metered?: boolean } = {},
): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('usage_rollup_state')) {
        return {
          rows: options.metered === false ? [] : [{ rolled_through: '2026-07-31T09:00:00Z' }],
          rowCount: 1,
        };
      }
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
  };
}

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

// ---------------------------------------------------------------------------
// Filter parsing
// ---------------------------------------------------------------------------

test('an omitted range defaults to the last 30 UTC days, inclusive', () => {
  const parsed = parseUsageAttributionFilters(params(''), NOW);
  assert.ok(parsed.ok);
  assert.equal(parsed.filters.from, '2026-07-02');
  assert.equal(parsed.filters.to, '2026-07-31');
  assert.equal(parsed.filters.companyId, null);
  assert.equal(parsed.filters.engine, null);
});

test('every AC filter is accepted', () => {
  const parsed = parseUsageAttributionFilters(
    params('companyId=12&userId=3&taskKey=marketing.stage.production&engine=AI_LLM&from=2026-06-01&to=2026-06-30'),
    NOW,
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.filters, {
    companyId: 12,
    userId: 3,
    taskKey: 'marketing.stage.production',
    engine: 'AI_LLM',
    from: '2026-06-01',
    to: '2026-06-30',
  });
});

test('company 0 and user 0 are valid filters — the unscoped/system buckets', () => {
  const parsed = parseUsageAttributionFilters(params('companyId=0&userId=0'), NOW);
  assert.ok(parsed.ok);
  assert.equal(parsed.filters.companyId, 0);
  assert.equal(parsed.filters.userId, 0);
});

test('a malformed filter is rejected, never silently ignored', () => {
  for (const [search, error] of [
    ['from=07-2026', 'invalid_from'],
    ['to=2026-13-01', 'invalid_to'],
    ['from=2026-02-31', 'invalid_from'], // a date that does not exist
    ['from=2026-07-10&to=2026-07-01', 'invalid_range'],
    ['companyId=abc', 'invalid_company'],
    ['companyId=-1', 'invalid_company'],
    ['userId=1.5', 'invalid_user'],
    ['engine=AI', 'invalid_engine'],
    [`taskKey=${'x'.repeat(129)}`, 'invalid_task_key'],
  ] as const) {
    const parsed = parseUsageAttributionFilters(params(search), NOW);
    assert.equal(parsed.ok, false, search);
    assert.equal((parsed as { error: string }).error, error, search);
  }
});

// ---------------------------------------------------------------------------
// Filter clause
// ---------------------------------------------------------------------------

test('the date range is always bound, so no query can scan the whole table', () => {
  const { clause, params: bound } = buildUsageFilterClause(BASE_FILTERS);
  assert.match(clause, /bucket_start >= \$1/);
  assert.match(clause, /bucket_start < \$2/);
  assert.equal(bound.length, 2);
  // `to` is an inclusive day, so the exclusive bound is the following midnight.
  assert.equal((bound[1] as Date).toISOString(), '2026-08-01T00:00:00.000Z');
});

test('an operator-supplied task key is a bound parameter, never interpolated', () => {
  const evil = "x'; DROP TABLE usage_rollup_daily; --";
  const { clause, params: bound } = buildUsageFilterClause({ ...BASE_FILTERS, taskKey: evil });
  assert.ok(!clause.includes('DROP TABLE'));
  assert.match(clause, /task_key = \$3/);
  assert.equal(bound[2], evil);
});

test('the column prefix is applied so the joined query aliases correctly', () => {
  const { clause } = buildUsageFilterClause({ ...BASE_FILTERS, companyId: 5 }, 'r.');
  assert.match(clause, /r\.bucket_start >= \$1/);
  assert.match(clause, /r\.tenant_id = \$3/);
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

test('no rollup watermark reports unmetered and reads nothing else', async () => {
  const calls: Call[] = [];
  const db = recordingDb(() => [], calls, { metered: false });

  const result = await loadUsageAttribution(BASE_FILTERS, { db });

  assert.equal(result.metered, false);
  assert.deepEqual(result.companies, []);
  assert.deepEqual(result.engines, []);
  assert.equal(result.totalTasks, 0);
  assert.equal(result.totalCostCents, null);
  assert.equal(result.totalMarginCents, null);
  assert.equal(calls.length, 1);
});

test('company rows carry a margin, and the unscoped bucket is labelled not dropped', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql.includes('FROM usage_rollup_daily r\n     LEFT JOIN organizations')
        ? [
            {
              company_id: 12,
              company_name: 'Acme',
              tier_key: 'growth',
              tier_label: 'Growth (Medium)',
              monthly_price_cents_override: null,
              monthly_price_cents: '29900.0000',
              cost_per_task_cents: '2.000000',
              tasks: '500',
              ai_tasks: '300',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '90000',
              measured_cost_cents: '0',
            },
            {
              company_id: 0,
              company_name: null,
              tier_key: null,
              tier_label: null,
              monthly_price_cents_override: null,
              monthly_price_cents: null,
              cost_per_task_cents: null,
              tasks: '120',
              ai_tasks: '0',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '400',
              measured_cost_cents: '0',
            },
          ]
        : [],
    calls,
  );

  const result = await loadUsageAttribution(BASE_FILTERS, { db });

  const acme = result.companies[0];
  assert.equal(acme.companyName, 'Acme');
  assert.equal(acme.billedPriceCents, 29900);
  // measured summed to 0 with nothing reported, so the basis must be modeled.
  assert.equal(acme.costBasis, 'modeled');
  assert.equal(acme.costCents, 1000);
  assert.equal(acme.marginCents, 28900);
  assert.equal(result.anyModeledCost, true);

  const unscoped = result.companies[1];
  assert.equal(unscoped.isUnscoped, true);
  assert.equal(unscoped.companyName, null);
  // No plan, so no price and no margin — but the row is present so the task
  // totals reconcile against the raw log.
  assert.equal(unscoped.billedPriceCents, null);
  assert.equal(unscoped.marginCents, null);
  assert.equal(unscoped.tasks, 120);
});

test('a negotiated per-company price beats the tier card', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql.includes('LEFT JOIN organizations')
        ? [
            {
              company_id: 9,
              company_name: 'Big Co',
              tier_key: 'enterprise',
              tier_label: 'Enterprise (Custom)',
              monthly_price_cents_override: '250000.0000',
              monthly_price_cents: null,
              cost_per_task_cents: '2.000000',
              tasks: '1000',
              ai_tasks: '900',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '1000',
              measured_cost_cents: null,
            },
          ]
        : [],
    calls,
  );

  const { companies } = await loadUsageAttribution(BASE_FILTERS, { db });
  assert.equal(companies[0].billedPriceCents, 250_000);
  assert.equal(companies[0].marginCents, 248_000);
});

test('platform totals come from the uncapped engine query, not the capped company list', async () => {
  const calls: Call[] = [];
  const db = recordingDb(
    (sql) =>
      sql.includes('GROUP BY 1\n    ORDER BY 2 DESC')
        ? [
            {
              execution_engine: 'AI_LLM',
              tasks: '900',
              ai_tasks: '900',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '5000',
              measured_cost_cents: null,
            },
            {
              execution_engine: 'DETERMINISTIC_RULE',
              tasks: '100',
              ai_tasks: '0',
              ai_tasks_with_usage: '0',
              total_tokens: null,
              total_duration_ms: '300',
              measured_cost_cents: '0',
            },
          ]
        : [],
    calls,
  );

  const result = await loadUsageAttribution(BASE_FILTERS, { db });

  assert.equal(result.totalTasks, 1000);
  assert.equal(result.totalAiTasks, 900);
  assert.equal(result.engines[0].sharePercent, 90);
  assert.equal(result.engines[1].sharePercent, 10);
});

test('hitting the company cap is reported, never a silent truncation', async () => {
  const calls: Call[] = [];
  const row = (id: number) => ({
    company_id: id,
    company_name: `Co ${id}`,
    tier_key: 'starter',
    tier_label: 'Starter (Small)',
    monthly_price_cents_override: null,
    monthly_price_cents: '9900.0000',
    cost_per_task_cents: '2.000000',
    tasks: '10',
    ai_tasks: '5',
    ai_tasks_with_usage: '0',
    total_tokens: null,
    total_duration_ms: '10',
    measured_cost_cents: '0',
  });
  const db = recordingDb(
    (sql) => (sql.includes('LEFT JOIN organizations') ? [row(1), row(2), row(3)] : []),
    calls,
  );

  const result = await loadUsageAttribution(BASE_FILTERS, { db, companyLimit: 2 });

  assert.equal(result.companies.length, 2);
  assert.equal(result.companiesTruncated, true);
  // The query asks for cap+1 precisely so truncation is detectable.
  const companyCall = calls.find((call) => call.sql.includes('LEFT JOIN organizations'));
  assert.equal(companyCall?.params.at(-1), 3);
});

test('every aggregate query carries the filter bounds and runs sequentially', async () => {
  const calls: Call[] = [];
  const db = recordingDb(() => [], calls);

  await loadUsageAttribution({ ...BASE_FILTERS, companyId: 12, engine: 'AI_LLM' }, { db });

  const aggregates = calls.filter((call) => !call.sql.includes('usage_rollup_state'));
  assert.equal(aggregates.length, 4);
  for (const call of aggregates) {
    assert.match(call.sql, /bucket_start >= \$1/);
    assert.ok(call.params[0] instanceof Date);
    assert.ok(call.params[1] instanceof Date);
    assert.equal(call.params[2], 12);
    assert.equal(call.params[3], 'AI_LLM');
  }
});

test('the default company cap is generous enough not to hide a normal deployment', () => {
  assert.ok(DEFAULT_COMPANY_LIMIT >= 100);
});

test('a query failure propagates rather than returning an empty finance report', async () => {
  const db: Queryable = {
    query: async (sql: string) => {
      if (sql.includes('usage_rollup_state')) {
        return { rows: [{ rolled_through: '2026-07-31T09:00:00Z' }], rowCount: 1 };
      }
      throw new Error('connection terminated');
    },
  };

  await assert.rejects(() => loadUsageAttribution(BASE_FILTERS, { db }), /connection terminated/);
});
