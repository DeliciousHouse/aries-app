-- connected_accounts: end-user social/ad connections established through the
-- optional Composio integration layer (backend/integrations/composio).
--
-- SECURITY: no access/refresh-token column by design. We persist the Composio
-- connected_account_id (a pointer to the credential Composio holds) and the
-- auth_config_id, never the raw OAuth secret. Disabling Composio
-- (COMPOSIO_ENABLED=false) leaves this table unused and harmless; dropping the
-- integration is `DROP TABLE connected_accounts;` plus removing the module.

CREATE TABLE IF NOT EXISTS connected_accounts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook','instagram','meta_ads','tiktok','youtube','linkedin','reddit')),
  provider TEXT NOT NULL DEFAULT 'composio' CHECK (provider IN ('composio','direct_meta','none')),
  connected_account_id TEXT,
  auth_config_id TEXT,
  external_account_id TEXT,
  external_account_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('not_connected','pending','connected','reauthorization_required','error')),
  capabilities_json JSONB,
  last_capability_check_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_tenant ON connected_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_tenant_platform ON connected_accounts (tenant_id, platform);
