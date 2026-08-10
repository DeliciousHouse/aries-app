-- migrations/manual/20260810_reconcile_superseded_oauth_connections.sql
--
-- OPERATOR-APPLIED, ONE-OFF RECONCILIATION. This file is NOT wired into
-- scripts/init-db.js and is NOT picked up by any auto-migration runner (there
-- is none in this repo; the migrations/ tree is a manual/reference catalogue
-- and init-db.js is the idempotent schema applier). Nothing in the app runs
-- this. Apply it by hand, with a backup, per the RUN MODE section below.
--
-- WHAT IT DOES
-- Reconciles the 3 stale legacy oauth_connections rows that disagree with the
-- authoritative Composio store (connected_accounts):
--   t15/facebook  (oauth=disconnected  vs ca=connected)
--   t15/linkedin  (oauth=pending       vs ca=connected)
--   t60/facebook  (oauth=disconnected  vs ca=connected)
--
-- CHOSEN APPROACH: UPDATE to a superseded marker (status='disconnected' +
-- last_error_code='superseded_by_composio'), NOT delete, NOT a new status.
--   * NOT status='connected': the legacy FB tokens were revoked on disconnect
--     (disconnect.ts -> dbRevokeTokensForConnection) and t15/linkedin never
--     completed its legacy flow — marking a token-less row 'connected' would
--     mislead any legacy token reader. 'disconnected' is the truthful legacy
--     state.
--   * NOT a new 'superseded' status value: the oauth_connections_status CHECK
--     allows only ('pending','connected','reauthorization_required',
--     'disconnected','error'); a new value needs a schema migration. The marker
--     rides in last_error_code instead (plain TEXT, no constraint).
--   * NOT DELETE: oauth_tokens.connection_id FK is ON DELETE CASCADE (a delete
--     would destroy revoked-token history), and oauth_pending_states /
--     oauth_audit_events would have connection_id NULLed — needless forensic
--     loss for zero behavioral gain. After the reader consolidation these rows
--     are inert while Composio is active, and under the legacy fall-through a
--     'disconnected' row renders identically to a missing row.
--
-- IDEMPOTENT: the UPDATE's WHERE excludes already-marked rows, so a re-run
-- matches 0 rows, writes 0 audit events, and revokes 0 tokens. SAFE to run
-- BEFORE or AFTER the code deploy: pre-deploy it only changes t15/linkedin's
-- legacy-read status from pending_oauth to the truthful 'disconnected' (no
-- in-flight legacy OAuth exists); post-deploy the 3 rows are unread for these
-- platforms while Composio is active. GUARDED by a join requiring a connected
-- composio connected_accounts row for the same (tenant_id, platform), so it can
-- never mark a row that Composio does not actually cover — if a target pair's
-- ca row is not exactly provider='composio' AND status='connected' at run time,
-- that pair is skipped (re-check and re-run rather than loosening the guard).
--
-- ============================ RUN MODE ==============================
-- This file is split into THREE steps. Steps 0 and 2 are read-only SELECTs and
-- live OUTSIDE any transaction. Step 1 is the single BEGIN...COMMIT mutation.
--
-- Recommended (interactive, with an eyeball gate):
--   1. Run STEP 0 (preview). It is a LEFT JOIN, so all 3 target pairs always
--      appear; a pair skipped for a missing/changed ca row shows NULL ca_*
--      columns. Confirm exactly 3 rows and that each has ca_provider='composio'
--      and ca_status='connected'. If any ca_* is NULL, STOP and investigate —
--      do not run STEP 1 until the ca row is correct.
--   2. Run STEP 1 (the transaction) in the same psql session.
--   3. Run STEP 2 (verify): all 3 rows disconnected + marked, zero live tokens.
--
-- Non-interactive (`psql -f` of STEP 1 alone) is also SAFE without the eyeball:
-- the guarded WHERE (ca.provider='composio' AND ca.status='connected' + the
-- hardcoded pairs + the marker-exclusion) fully bounds the write, so the STEP 0
-- eyeball is advisory, not a correctness gate. If you run the whole file
-- non-interactively, STEP 0/STEP 2 simply print to stdout and the COMMIT in
-- STEP 1 applies. Take a backup first regardless (pg_dump of oauth_connections,
-- oauth_tokens, oauth_pending_states, oauth_audit_events, connected_accounts,
-- or the standard pg_dumpall).
-- ===================================================================


-- ------------------------------------------------------------------ STEP 0
-- PREVIEW (read-only, run outside a transaction). LEFT JOIN so a skipped pair
-- is visible with NULL ca columns instead of silently vanishing.
SELECT oc.id,
       oc.tenant_id,
       oc.provider,
       oc.status            AS legacy_status,
       oc.last_error_code,
       ca.provider          AS ca_provider,
       ca.status            AS ca_status
FROM oauth_connections oc
LEFT JOIN connected_accounts ca
  ON ca.tenant_id = oc.tenant_id
 AND ca.platform  = oc.provider
WHERE (oc.tenant_id, oc.provider) IN ((15, 'facebook'), (15, 'linkedin'), (60, 'facebook'))
ORDER BY oc.tenant_id, oc.provider;


-- ------------------------------------------------------------------ STEP 1
-- THE RECONCILIATION (single transaction).
BEGIN;

WITH superseded AS (
  UPDATE oauth_connections oc
  SET status             = 'disconnected',
      disconnected_at    = COALESCE(oc.disconnected_at, now()),
      last_error_code    = 'superseded_by_composio',
      last_error_message = 'Connection is brokered by Composio; connected_accounts is authoritative. Legacy tokens revoked or never issued.',
      updated_at         = now()
  FROM connected_accounts ca
  WHERE ca.tenant_id = oc.tenant_id
    AND ca.platform  = oc.provider
    AND ca.provider  = 'composio'
    AND ca.status    = 'connected'
    AND (oc.tenant_id, oc.provider) IN ((15, 'facebook'), (15, 'linkedin'), (60, 'facebook'))
    -- Idempotency guard: skip rows already in the superseded marker state.
    AND (oc.status IS DISTINCT FROM 'disconnected'
         OR oc.last_error_code IS DISTINCT FROM 'superseded_by_composio')
  RETURNING oc.id, oc.tenant_id, oc.provider
),
-- Belt-and-braces: ensure no live legacy token survives on a superseded
-- connection (expected no-op: FB tokens already revoked; linkedin was pending).
revoked AS (
  UPDATE oauth_tokens t
  SET revoked_at = COALESCE(t.revoked_at, now())
  FROM superseded s
  WHERE t.connection_id = s.id
    AND t.revoked_at IS NULL
  RETURNING t.id, t.connection_id
)
INSERT INTO oauth_audit_events (tenant_id, connection_id, provider, event_type, event_status, detail)
SELECT s.tenant_id,
       s.id,
       s.provider,
       'connection_superseded_by_composio',
       'ok',
       jsonb_build_object(
         'reason', 'row_reconciliation_2026_08',
         'note', 'connected_accounts is authoritative for composio-brokered platforms',
         -- Per-connection count (correlated on connection_id) so each audit row
         -- reflects the tokens revoked on ITS OWN connection, not the global
         -- total across all reconciled rows.
         'revoked_token_count', (SELECT count(*) FROM revoked r WHERE r.connection_id = s.id)
       )
FROM superseded s;

-- Housekeeping: drop any EXPIRED one-shot pending OAuth states for these pairs
-- (t15/linkedin's stale 'pending' likely left one behind). Expired states are
-- unusable by design; idempotent.
DELETE FROM oauth_pending_states ps
WHERE ps.expires_at < now()
  AND (ps.tenant_id, ps.provider) IN ((15, 'facebook'), (15, 'linkedin'), (60, 'facebook'));

COMMIT;


-- ------------------------------------------------------------------ STEP 2
-- VERIFY (read-only, run outside a transaction). Expect all 3 rows
-- 'disconnected' + last_error_code='superseded_by_composio', live_tokens = 0.
SELECT oc.tenant_id,
       oc.provider,
       oc.status,
       oc.last_error_code,
       oc.disconnected_at,
       (SELECT count(*) FROM oauth_tokens t
         WHERE t.connection_id = oc.id AND t.revoked_at IS NULL) AS live_tokens
FROM oauth_connections oc
WHERE (oc.tenant_id, oc.provider) IN ((15, 'facebook'), (15, 'linkedin'), (60, 'facebook'))
ORDER BY oc.tenant_id, oc.provider;
