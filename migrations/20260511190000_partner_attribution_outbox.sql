-- Partner attribution outbox: async POST to VMS /api/aries/signup with retries.
-- Applied via scripts/init-db.js in dev/CI; run this file manually on existing DBs if needed.

CREATE TABLE IF NOT EXISTS partner_attribution_outbox (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  ref_code        TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  company         TEXT,
  domain          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INT  NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  CONSTRAINT partner_attribution_outbox_status_valid CHECK (status IN ('pending','delivered','dead'))
);

CREATE INDEX IF NOT EXISTS idx_partner_attribution_outbox_pending
  ON partner_attribution_outbox (next_attempt_at)
  WHERE status = 'pending';
