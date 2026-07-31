-- AA-165: the two operands margin needs, neither of which existed.
--
-- Before this migration `plan_rate_cards` recorded allowances and
-- cost_per_million_tokens_cents (a COST rate, declarative). There was no
-- subscription PRICE column anywhere in the schema, and no invoice or payment
-- table — so "margin = billed price - net API cost" had neither side.
--
--   monthly_price_cents          -> what the customer is billed for the tier.
--   monthly_price_cents_override -> the negotiated price for one company, the
--                                   same override shape the allowances use, so
--                                   Enterprise/Custom needs no bespoke path.
--   cost_per_task_cents          -> the MODELED cost of running one task.
--
-- Why a modeled cost rate exists at all, and what it is not:
--   measured cost is `task_execution_log.cost_cents`, which is a hard 0 on the
--   two zero-cost engines and NULL on every AI_LLM row, because Hermes owns
--   model routing and does not report usage back to Aries. So a margin built on
--   measured cost reads "100% margin" for every client today — worse than no
--   number, because Finance would act on it. This column is an explicitly
--   configured ASSUMPTION that lets the internal dashboard model COGS now, and
--   it is labelled `modeled` everywhere it surfaces.
--
-- The boundary AA-163 drew still holds and is deliberately NOT relaxed:
--   daily_company_usage.total_cogs_cents stays sum(cost_cents) from the raw log,
--   the enforcement gate still reads allowances only, and no customer-facing
--   surface reads these columns. The moment Hermes reports usage, the internal
--   dashboard's cost basis flips from `modeled` to `measured` on its own —
--   backend/billing/margin.ts prefers measured whenever any usage was reported.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

ALTER TABLE plan_rate_cards
  ADD COLUMN IF NOT EXISTS monthly_price_cents NUMERIC(12,4);

ALTER TABLE plan_rate_cards
  ADD COLUMN IF NOT EXISTS cost_per_task_cents NUMERIC(12,6);

ALTER TABLE company_subscriptions
  ADD COLUMN IF NOT EXISTS monthly_price_cents_override NUMERIC(12,4);

-- Seed starting values WHERE NULL only — never a blanket UPDATE. An edited price
-- must survive every container start, exactly like the ON CONFLICT DO NOTHING
-- that protects the allowance seed. A tier whose price a PM has already set is
-- left untouched here and on every re-run.
UPDATE plan_rate_cards SET monthly_price_cents = 9900.0000
  WHERE tier_key = 'starter' AND monthly_price_cents IS NULL;
UPDATE plan_rate_cards SET monthly_price_cents = 29900.0000
  WHERE tier_key = 'growth' AND monthly_price_cents IS NULL;
UPDATE plan_rate_cards SET monthly_price_cents = 99900.0000
  WHERE tier_key = 'scale' AND monthly_price_cents IS NULL;
-- Enterprise is negotiated per company and stays NULL: its price lives in
-- company_subscriptions.monthly_price_cents_override. NULL means "no configured
-- price", which the dashboard renders as an unknown, never as a free client.

-- One modeled rate across all tiers as a starting point. It is per-tier
-- configurable because a heavier tier may route to pricier models; a PM tunes it
-- with plain SQL, no deploy.
UPDATE plan_rate_cards SET cost_per_task_cents = 2.000000
  WHERE cost_per_task_cents IS NULL;
