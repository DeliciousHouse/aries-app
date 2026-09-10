# Daily estimated AI cost

Import `ops/grafana/dashboards/aries/daily-estimated-cost.json` into the private
fleet Grafana alongside the existing Aries dashboards. This is an importable
configuration, not an assertion that the production panel is already live.

## Read contract

The panel's `rawSql` is the daily rollup query. It reads `task_execution_log`
directly, grouping `AI_LLM` attempts by tenant and UTC start date and summing
`cost_cents / 100` in PostgreSQL numeric arithmetic. Failed and retry attempts
count too. Unscoped (`tenant_id IS NULL`) and non-AI work are excluded; this is
per-tenant AI cost, not total fleet infrastructure spend.

- The cost column is **reported estimated AI cost**, not invoices or billing.
  A missing cost stays NULL; a mixed day shows only the known subtotal alongside
  its count of **AI attempts without cost**. Tokens do not imply cost coverage.
- The $100/day PESOSE reference is visible in the title and on every row. Known
  subtotals at or above $100 turn red; missing-cost counts turn orange. A value
  below $100 is not evidence of compliance while any cost is missing, and absent
  telemetry cannot establish compliance even if every retained row has a cost.
- The first selected day starts at UTC midnight even if the picker starts midday.
  The selected end is exclusive; its day is partial through that timestamp.
  The dashboard defaults to seven days back at midnight through now, in UTC.
- No rows means no retained tenant AI telemetry, **not** $0. Logging must be
  enabled with `ARIES_TASK_TELEMETRY_ENABLED`; Hermes may still leave costs
  unreported. This dashboard neither enables telemetry nor synthesizes prices.
- Raw history is subject to the existing retention policy (90 days by default).
  Do not use this panel for older history or billing. The existing
  `usage_rollup_daily` / `daily_company_usage` layer remains the owner of durable
  historical aggregates. It cannot give this panel cost coverage today:
  `ai_events_with_usage` counts token reports, not non-NULL costs.

No new worker, refresh job, API route, migration, or provider-pricing table is
needed. The query reads the current log and uses its existing engine/start-time
index. Keep the reporting window short; move cost-coverage counts into the
existing rollups if raw-log query latency becomes a problem.

## Fleet installation and rollback

1. Use a PostgreSQL datasource reachable only from the private monitoring network.
   Select the Aries database and use a dedicated read-only account with schema
   usage and SELECT on just `tenant_id`, `execution_engine`, `started_at`, and
   `cost_cents` in `task_execution_log`. Do not give Grafana application/admin
   credentials. Apply an appropriate datasource query timeout/connection cap.
2. In Grafana **Dashboards → New → Import**, upload the JSON and map
   **Aries PostgreSQL (read-only)** to that datasource. Restrict the dashboard and
   datasource to fleet operators: it intentionally lists multiple tenants, so it
   must not be shared with customer accounts or exposed publicly.
3. For file provisioning instead, replace `${DS_ARIES_POSTGRES}` with the existing
   datasource UID and remove `__inputs` in the deployed copy; Grafana's file
   provisioner does not run the import substitution. Use the fleet's existing
   dashboard provider, not a second monitoring stack. Store credentials in the
   fleet secret mechanism, never this JSON or the repository.
4. Confirm the UTC date, tenant, cost estimate, missing-cost count, and $100/day
   reference columns render. Compare one day's rows with the same `rawSql` via
   Query Inspector. Unknown days must say **Not reported**, not $0.

The five-minute refresh is read-only. There is no alert or spend enforcement in
this panel. Rollback is removal of dashboard UID `aries-daily-estimated-cost`
(or its provisioned file); no data rollback or app restart is required.

## Reproducible verification

With dependencies installed and the five `DB_*` variables pointing to a
**disposable PostgreSQL** database, run:

```bash
NODE_ENV=test APP_BASE_URL=https://aries.example.com \
  npx tsx --test tests/telemetry/daily-cost-dashboard.test.ts
```

The live test creates a session-local table from the shipped execution-log DDL,
seeds rows, executes the dashboard's exact SQL with only Grafana's time macros
replaced by bind parameters, and rolls everything back. No `db:init` is needed.
It checks two tenants across a UTC boundary under a non-UTC database session,
fractional cents, failures/retries, token-without-cost rows, mixed and entirely
missing costs, explicit zero, excluded unscoped/non-AI work, time bounds, repeated
reads, and an empty log. Expected daily costs: tenant 15 = $100.25 then $0.50;
tenant 16 = unreported then $0. Without DB env, the config test runs and the SQL
test explicitly skips; a skipped SQL test is not verification of the rollup.
