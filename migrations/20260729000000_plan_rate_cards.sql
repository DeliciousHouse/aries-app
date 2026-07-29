-- AA-163: tiered plan rate cards + per-company subscriptions, and the usage
-- allowance the pre-execution gate enforces.
--
-- Scope of this migration, decided up front:
--   * The rate card is DECLARATIVE. cost_per_million_tokens_cents is recorded so
--     a Product Manager can configure pricing, and nothing reads it to compute a
--     bill. daily_company_usage.total_cogs_cents remains sum(cost_cents) from the
--     raw log, which is NULL until Hermes reports usage. No cost is synthesized
--     from this table.
--   * Enforcement runs on TASK COUNTS, not tokens. Every AI_LLM row has NULL
--     tokens today (Hermes owns model routing and does not report usage back), so
--     a token gate would compare a limit against a permanently-zero counter and
--     never deny anything. Both allowances are stored from day one so the metric
--     can flip with an env var and no migration once Hermes reports.
--
-- The tier lives on the COMPANY (organizations), not on users. users.plan is a
-- per-account entitlement for multi-workspace (Decision 13) on a different axis;
-- folding tiers into it would break assertMultiWorkspaceEntitlement.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

-- Tier definitions. Rows, not code constants, because the AC is "As a Product
-- Manager I want to configure ..." — thresholds and rates must be editable
-- without a deploy (scripts/billing/set-company-plan.ts --list, or plain SQL).
-- A NULL allowance means UNLIMITED, which is how Enterprise/Custom is expressed:
-- it is not a fifth hardcoded tier, it is this tier plus per-company overrides.
CREATE TABLE IF NOT EXISTS plan_rate_cards (
  tier_key                      TEXT PRIMARY KEY
    CHECK (tier_key IN ('starter','growth','scale','enterprise')),
  display_name                  TEXT NOT NULL,
  monthly_task_allowance        BIGINT,
  monthly_token_allowance       BIGINT,
  cost_per_million_tokens_cents NUMERIC(12,4),
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded starting values, tunable by a PM without a deploy. ON CONFLICT DO
-- NOTHING is load-bearing: an edited rate must survive every container start, so
-- this seeds absent rows and never clobbers configured ones.
INSERT INTO plan_rate_cards
  (tier_key, display_name, monthly_task_allowance, monthly_token_allowance, cost_per_million_tokens_cents, sort_order)
VALUES
  ('starter',    'Starter (Small)',      1000,  2000000, 1500.0000, 1),
  ('growth',     'Growth (Medium)',      5000, 10000000, 1200.0000, 2),
  ('scale',      'Scale (Large)',       25000, 50000000, 1000.0000, 3),
  -- Enterprise is negotiated per company: unlimited by default, narrowed by the
  -- per-company override columns below.
  ('enterprise', 'Enterprise (Custom)',  NULL,     NULL,      NULL, 4)
ON CONFLICT (tier_key) DO NOTHING;

-- One active subscription per company. The override columns are what makes
-- Custom/Enterprise real: a negotiated allowance that beats its tier's card.
CREATE TABLE IF NOT EXISTS company_subscriptions (
  company_id                       INTEGER PRIMARY KEY
    REFERENCES organizations(id) ON DELETE CASCADE,
  tier_key                         TEXT NOT NULL REFERENCES plan_rate_cards(tier_key),
  monthly_task_allowance_override  BIGINT,
  monthly_token_allowance_override BIGINT,
  assigned_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by                      TEXT,
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every existing company starts on the entry tier. Idempotent: a company whose
-- plan has since been changed keeps it.
INSERT INTO company_subscriptions (company_id, tier_key, assigned_by)
  SELECT o.id, 'starter', 'init-db:backfill' FROM organizations o
  ON CONFLICT (company_id) DO NOTHING;
