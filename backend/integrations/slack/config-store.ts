/**
 * Per-tenant Slack config resolver (Phase 4 / Option A, T3).
 *
 * Resolves the bot token + notify channel for a tenant's connected Slack
 * workspace so `notifyApprovalRequired` posts into THAT tenant's channel with
 * THAT tenant's token, instead of a single global env channel/token shared
 * across tenants (the cross-tenant disclosure gap PR2 flagged).
 *
 * Precedence:
 *   1. Per-tenant: a `connected` Slack `oauth_connections` row with a decrypted
 *      bot token AND a `notify_channel_id`. Both must be present — a tenant token
 *      is NEVER paired with a global channel (or vice-versa).
 *   2. Explicit single-tenant opt-in: BOTH `SLACK_SINGLE_TENANT_CHANNEL` and
 *      `SLACK_BOT_TOKEN` set. This is the self-host / single-tenant escape hatch;
 *      it is never a silent default — both env vars must be set on purpose.
 *   3. Otherwise `null` → the caller skips with reason `no_tenant_config`.
 *
 * Fail-open: any DB/decrypt error in the per-tenant path falls through to the
 * env opt-in (or null). The resolver NEVER throws — the caller is fire-and-forget
 * and the dashboard remains the source of truth. The decrypted token is a secret;
 * it is returned but never logged here.
 */
import type { Pool } from 'pg';

import { pool as defaultPool } from '@/lib/db';
import { getDecryptedAccessTokenContextForTenantProvider } from '@/backend/integrations/oauth-credentials';

export interface SlackTenantConfig {
  botToken: string;
  channel: string;
}

/** Injectable deps — the test seam. Every field defaults to the production impl. */
export interface LoadSlackConfigDeps {
  /** pg Pool (only `.query` is used). Defaults to the shared `@/lib/db` pool. */
  pool?: Pool;
  /** Token resolver. Defaults to `getDecryptedAccessTokenContextForTenantProvider`. */
  getToken?: (
    tenantIdStr: string,
    provider: string,
  ) => Promise<{ accessToken: string; connectionId: string; externalAccountId: string | null } | null>;
  /** Env bag for the global opt-in fallback. Defaults to `process.env`. */
  env?: Partial<Record<string, string | undefined>>;
}

export async function loadSlackConfigForTenant(
  tenantId: number | string | null | undefined,
  deps: LoadSlackConfigDeps = {},
): Promise<SlackTenantConfig | null> {
  const pool = deps.pool ?? defaultPool;
  const getToken = deps.getToken ?? getDecryptedAccessTokenContextForTenantProvider;
  const env = deps.env ?? process.env;

  // 1. Per-tenant first. Fail-open: any throw falls through to the env opt-in.
  try {
    if (tenantId != null) {
      const tenantIdStr = String(tenantId);

      // 1a. Decrypted bot token for this tenant's connected Slack connection.
      const tokenCtx = await getToken(tenantIdStr, 'slack');
      const botToken = tokenCtx?.accessToken?.trim() ?? '';

      // 1b. Notify channel — a focused, status-filtered SELECT. The credential
      //     read path does not return notify_channel_id, and dbGetConnection
      //     does not filter on status, so the resolver owns this read.
      if (botToken) {
        const orgId = Number.parseInt(tenantIdStr, 10);
        if (Number.isFinite(orgId) && orgId >= 1) {
          const res = await pool.query(
            `SELECT notify_channel_id
               FROM oauth_connections
              WHERE tenant_id = $1 AND provider = 'slack' AND status = 'connected'
              ORDER BY connected_at DESC NULLS LAST, updated_at DESC
              LIMIT 1`,
            [orgId],
          );
          const row = (res.rows?.[0] ?? null) as { notify_channel_id: string | null } | null;
          const channel = typeof row?.notify_channel_id === 'string' ? row.notify_channel_id.trim() : '';

          // Only a COMPLETE per-tenant config (token + channel) wins. A missing
          // channel must not pair the tenant token with a global channel — fall
          // through so the explicit env opt-in (global token + channel) decides.
          if (channel) {
            return { botToken, channel };
          }
        }
      }
    }
  } catch {
    // fail-open: never throw out of the resolver.
  }

  // 2. Explicit single-tenant global opt-in — BOTH must be set, never a silent default.
  const globalChannel = (env.SLACK_SINGLE_TENANT_CHANNEL ?? '').trim();
  const globalToken = (env.SLACK_BOT_TOKEN ?? '').trim();
  if (globalChannel && globalToken) {
    return { botToken: globalToken, channel: globalChannel };
  }

  // 3. Nothing resolved.
  return null;
}
