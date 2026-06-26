-- Workspace member invitations.
--
-- Backs the "add people to the workspace" flow: an admin invites a teammate by
-- email + role, which creates a pending users row (password_hash =
-- 'invited_pending') plus an invitation row here holding a hashed, single-use
-- token. The teammate clicks the emailed link, sets a password, and the
-- invitation is consumed (accepted_at set). Tokens are stored hashed (sha256)
-- so a DB read never yields a usable link, mirroring password_resets.
--
-- Cleanup is via ON DELETE CASCADE: removing the member (DELETE FROM users)
-- removes their outstanding invitations, and dropping an organization removes
-- everything beneath it.

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Token lookup on accept/validate is by hash; one live token per hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_token_hash
  ON workspace_invitations (token_hash);

-- Per-tenant member listing joins outstanding invitations by org.
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_org_user
  ON workspace_invitations (organization_id, user_id);
