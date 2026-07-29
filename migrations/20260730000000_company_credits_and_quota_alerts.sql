-- AA-164: purchased task credits + quota-threshold alert dedupe.
--
-- DENOMINATION: credits are TASK credits, the same unit AA-163 enforces on.
-- Tokens are not usable as a billing unit yet — every AI_LLM row carries NULL
-- tokens because Hermes owns model routing and does not report usage back — so a
-- token balance would be a number nobody can spend and a percentage that never
-- moves. When Hermes reports usage the metric flips via
-- ARIES_PLAN_ENFORCEMENT_METRIC and this ledger's unit follows it.
--
-- The ledger is append-only. A balance is a SUM over unexpired rows, never a
-- mutable counter: a decrement-in-place column loses its own audit trail the
-- moment two writers race, and "why does this company have N credits" has to be
-- answerable from the table itself.
--
-- Credits stack ON TOP of the plan's monthly allowance and do NOT reset with the
-- calendar month (expires_at NULL = never). A customer who pays for extra
-- capacity keeps it until it is spent or explicitly dated out; silently voiding
-- purchased credits at a month boundary would be taking money for nothing.
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

CREATE TABLE IF NOT EXISTS company_credit_ledger (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Signed: a negative row is a correction/clawback, so a mistake is reversed by
  -- appending its inverse rather than by editing history.
  credits           BIGINT  NOT NULL CHECK (credits <> 0),
  source            TEXT    NOT NULL CHECK (source IN ('purchase','grant','correction')),
  -- The payment gateway's event id. UNIQUE (below) is what makes fulfillment
  -- idempotent: gateways redeliver webhooks routinely, and crediting a customer
  -- twice for one payment is a money bug. NULL for manual grants.
  external_event_id TEXT,
  note              TEXT,
  granted_by        TEXT,
  -- NULL = never expires. Credits deliberately survive the month boundary.
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial UNIQUE: one ledger row per gateway event, while manual grants (NULL)
-- stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_credit_ledger_external_event
  ON company_credit_ledger (external_event_id) WHERE external_event_id IS NOT NULL;
-- Serves the balance sum and the per-company history read.
CREATE INDEX IF NOT EXISTS idx_company_credit_ledger_company_created
  ON company_credit_ledger (company_id, created_at DESC);

-- One row per (company, billing period, threshold) — the PRIMARY KEY IS the
-- dedupe key. The alert sweep runs on every rollup tick (hourly), so without
-- this a company sitting at 96% would be emailed every hour until the month
-- turned over. Same shape as slack_notifications' stable-key dedupe.
CREATE TABLE IF NOT EXISTS usage_alert_notifications (
  company_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start DATE    NOT NULL,
  threshold    INTEGER NOT NULL CHECK (threshold IN (80, 95)),
  recipients   INTEGER NOT NULL DEFAULT 0,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period_start, threshold)
);
