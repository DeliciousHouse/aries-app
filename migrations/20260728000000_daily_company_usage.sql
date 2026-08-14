-- AA-162: daily per-company usage aggregation for dashboards and chargeback.
--
-- Grain: one row per (company, UTC calendar day). This is the COARSE surface —
-- usage_rollup_daily (AA-161) keeps the same day at
-- day x tenant x user x engine x task_key, which is the right shape for drilling
-- into a bill but the wrong shape for "show this customer their month".
--
-- Vocabulary map: company_id -> tenant_id (-> organizations), matching the
-- usage_events view.
--
-- A MATERIALIZED VIEW is the right tool HERE, unlike in AA-161, and for a
-- specific reason: its source is usage_rollup_daily, not task_execution_log. The
-- two objections that ruled an MV out over the raw log — a full rescan of a
-- high-volume table on every refresh, and being destroyed by the 90-day raw purge
-- — both vanish. usage_rollup_daily is already aggregated, small, and never swept
-- by the retention sweep, so a full refresh is cheap and the history is permanent.
--
-- Refresh: backend/telemetry/usage-rollups.ts issues
-- REFRESH MATERIALIZED VIEW CONCURRENTLY at the end of each rollup pass in the
-- aries-usage-rollup-worker sidecar (Postgres has no scheduler in this stack — no
-- pg_cron, no Timescale). CONCURRENTLY keeps dashboard reads unblocked during the
-- rebuild and REQUIRES the unique index below; it also cannot run inside a
-- transaction block, so it is issued as its own statement outside any BEGIN.
--
-- COGS is explicitly estimated: cost_cents is a hard 0 on
-- DETERMINISTIC_RULE/LOCAL_EDGE rows and, when Hermes reports total tokens, an
-- operator-calibrated blended-rate estimate on AI_LLM rows. Missing usage stays
-- NULL. That is exactly why
-- ai_tasks and tasks_with_usage_reported ride alongside the sums: they are the
-- denominators that let a consumer tell "$0 spent" from "nothing reported its
-- spend". A chargeback that reads total_cogs_cents without them will silently bill
-- zero.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_company_usage AS
  SELECT
    tenant_id AS company_id,
    -- usage_rollup_daily buckets are already UTC midnight; the cast just gives
    -- consumers a calendar date to group and join on.
    (bucket_start AT TIME ZONE 'UTC')::date AS usage_date,
    -- Total executions LOGGED, retries included — the literal "total tasks".
    -- settled_tasks and retries are broken out beside it because one logical task
    -- that retried twice is three rows (the AA-158 retry axis), and a chargeback
    -- has to be able to pick which number it means rather than inherit ours.
    sum(events)::bigint                AS total_tasks,
    (sum(succeeded) + sum(failed))::bigint AS settled_tasks,
    sum(retries)::bigint               AS retries,
    -- Denominators: how much of this day's work was AI at all, and how much of
    -- THAT actually reported its usage. Without these, total_cogs_cents = 0 is
    -- indistinguishable from "unreported".
    sum(ai_events)::bigint             AS ai_tasks,
    sum(ai_events_with_usage)::bigint  AS tasks_with_usage_reported,
    -- SUM skips NULLs, so an all-unreported day stays NULL rather than becoming a
    -- fabricated 0.
    sum(prompt_tokens)::bigint         AS total_prompt_tokens,
    sum(completion_tokens)::bigint     AS total_completion_tokens,
    sum(total_tokens)::bigint          AS total_tokens,
    sum(duration_ms_sum)::bigint       AS total_duration_ms,
    sum(cpu_ms_sum)::bigint            AS total_cpu_ms,
    sum(cost_cents)                    AS total_cogs_cents,
    max(updated_at)                    AS source_updated_at
  FROM usage_rollup_daily
  GROUP BY 1, 2;

-- REQUIRED by REFRESH ... CONCURRENTLY, which refuses to run without a unique
-- index — this is not an optional performance index. Leading company_id also
-- serves the "one customer, one billing period" read, so no second index is added.
--
-- company_id 0 is the AA-161 "not scoped" sentinel: system sweeps, the reconciler,
-- the weekly cron and every Hermes callback are not tenant-scoped. It is kept
-- rather than filtered so the view's totals reconcile against the raw log; a
-- customer-facing surface should exclude it explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_company_usage_company_date
  ON daily_company_usage (company_id, usage_date);

-- Recovery note: an MV created WITH NO DATA can never be refreshed CONCURRENTLY.
-- This statement creates it WITH DATA (the default), so that cannot happen here —
-- but if the concurrent refresh ever starts failing for that reason, the one-time
-- fix is a plain `REFRESH MATERIALIZED VIEW daily_company_usage`. It is left
-- manual on purpose: a plain refresh takes an AccessExclusiveLock and would block
-- every dashboard read, which is not something a sidecar should do to itself
-- automatically.
