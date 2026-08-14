-- B7 tenant lifecycle hygiene: organization classification, connection-state
-- transition timestamps, and durable owner-nudge claims.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'production'
    CHECK (kind IN ('production', 'test', 'archived'));

ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
UPDATE connected_accounts
   SET status_changed_at = COALESCE(updated_at, created_at, now())
 WHERE status_changed_at IS NULL;
ALTER TABLE connected_accounts
  ALTER COLUMN status_changed_at SET DEFAULT now(),
  ALTER COLUMN status_changed_at SET NOT NULL;

ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
UPDATE oauth_connections
   SET status_changed_at = COALESCE(updated_at, created_at, now())
 WHERE status_changed_at IS NULL;
ALTER TABLE oauth_connections
  ALTER COLUMN status_changed_at SET DEFAULT now(),
  ALTER COLUMN status_changed_at SET NOT NULL;

CREATE OR REPLACE FUNCTION set_connection_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS connected_accounts_status_changed_at ON connected_accounts;
CREATE TRIGGER connected_accounts_status_changed_at
BEFORE UPDATE OF status ON connected_accounts
FOR EACH ROW EXECUTE FUNCTION set_connection_status_changed_at();

DROP TRIGGER IF EXISTS oauth_connections_status_changed_at ON oauth_connections;
CREATE TRIGGER oauth_connections_status_changed_at
BEFORE UPDATE OF status ON oauth_connections
FOR EACH ROW EXECUTE FUNCTION set_connection_status_changed_at();

CREATE TABLE IF NOT EXISTS connection_nudge_notifications (
  source TEXT NOT NULL CHECK (source IN ('connected_accounts', 'oauth_connections')),
  connection_id BIGINT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  nudge_kind TEXT NOT NULL CHECK (nudge_kind IN ('reauthorization_required', 'pending_over_7_days')),
  status_changed_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, connection_id, nudge_kind, status_changed_at)
);

CREATE INDEX IF NOT EXISTS idx_connection_nudges_tenant_sent
  ON connection_nudge_notifications (tenant_id, sent_at DESC);
