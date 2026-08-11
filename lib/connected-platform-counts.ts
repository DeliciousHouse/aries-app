/**
 * "How many publishing channels has this tenant actually connected?" — the SQL,
 * in exactly one place.
 *
 * Two consumers need this answer and MUST agree:
 *  - `lib/onboarding-gate.ts` (the dashboard advisory + the Stage 4 publish
 *    precheck, via `tenantNeedsChannelConnection`);
 *  - `backend/marketing/primary-publish-platforms.ts` (which primary platforms
 *    a weekly run synthesizes rows for).
 * The gate lives in `lib/` and is reachable from the app shell; the resolver
 * lives in the marketing backend. Putting the queries here — a module with NO
 * imports beyond pg's types — lets both share them without either dragging the
 * other's dependency graph (business-profile / brand-kit / pool) along.
 *
 * Post-AA-216 `connected_accounts` is the authoritative connection store;
 * `oauth_connections` remains as the legacy direct-Meta fall-through, which is
 * why the Meta branch reads BOTH stores. `status = 'connected'` is enforced in
 * every branch: a pending link must never unblock publishing.
 *
 * WHY THE `oauth_connections` BRANCH STAYS PINNED TO facebook/instagram — the
 * reason is DISPATCHABILITY, not row shape. That table does in fact contain
 * non-Meta rows left over from earlier connect flows (live today: tenant 17 has
 * `linkedin|connected` and `x|pending`, tenant 15 has `linkedin|disconnected`).
 * They are deliberately not counted: every non-Meta publish goes through the
 * Composio publisher, whose `requireActiveConnection`
 * (backend/integrations/composio/connection-store.ts) reads `connected_accounts`
 * ONLY. An `oauth_connections` linkedin row therefore cannot dispatch a single
 * post, and counting it would open the gate onto a week of guaranteed failures.
 * Do NOT "fix" this by parameterizing the oauth branch on the belief that
 * non-Meta rows are impossible there — they are not impossible, they are
 * unpublishable.
 */

/**
 * Minimal query surface. Deliberately structural so a real `PoolClient`, the
 * `pg` `Pool`, and a plain test fake all satisfy it with no adapter.
 */
export interface PlatformCountQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/**
 * Meta-only connection count across BOTH stores. This is the LEGACY verdict —
 * the one the publish gate uses whenever `ARIES_ANY_PLATFORM_PUBLISH_ENABLED`
 * is OFF — and its text is deliberately frozen (byte-identical to the inline
 * SQL it replaced). The `oauth_connections` branch keeps the literal
 * `IN ('facebook','instagram')` because only direct-Meta rows in that store are
 * publishable — see the dispatchability note at the top of this file.
 */
export const COUNT_CONNECTED_META_PLATFORMS_SQL = `SELECT (
       (SELECT COUNT(*) FROM oauth_connections
          WHERE tenant_id = $1
            AND status = 'connected'
            AND provider IN ('facebook', 'instagram'))
       +
       (SELECT COUNT(*) FROM connected_accounts
          WHERE tenant_id = $1
            AND status = 'connected'
            AND platform IN ('facebook', 'instagram'))
     )::int AS connected_count`;

/**
 * Connection count over an arbitrary publishable-platform list (AA-217).
 *
 * The `oauth_connections` branch is byte-identical to the Meta query above and
 * stays that way ON PURPOSE: a non-Meta row in that store is not dispatchable
 * (the Composio publisher resolves connections from `connected_accounts` only),
 * so widening it would open the gate for a tenant whose every post would fail.
 * Live proof that such rows exist: tenant 17's `linkedin|connected`
 * `oauth_connections` row — which correctly leaves tenant 17 blocked. The
 * `connected_accounts` branch (authoritative) is the one that widens to
 * `platform = ANY($2)`, where `$2` is `publishablePlatforms()`. LinkedIn also
 * needs a non-empty `external_account_id`: the publisher uses it as the author
 * URN and refuses before dispatch when it is missing. Every row in this store
 * needs a non-empty `connected_account_id`: that is the credential pointer the
 * Composio publisher requires before it can dispatch any platform.
 */
export const COUNT_CONNECTED_PUBLISHABLE_PLATFORMS_SQL = `SELECT (
       (SELECT COUNT(*) FROM oauth_connections
          WHERE tenant_id = $1
            AND status = 'connected'
            AND provider IN ('facebook', 'instagram'))
       +
       (SELECT COUNT(*) FROM connected_accounts
          WHERE tenant_id = $1
            AND status = 'connected'
            AND platform = ANY($2)
            AND NULLIF(BTRIM(connected_account_id), '') IS NOT NULL
            AND (platform <> 'linkedin' OR NULLIF(BTRIM(external_account_id), '') IS NOT NULL))
     )::int AS connected_count`;

/**
 * Coerce a tenant id to a positive integer, or null when it is not one. Callers
 * treat null as "zero connections" — a fail-safe that keeps a malformed tenant
 * id blocked rather than accidentally unblocked.
 */
export function toPositiveTenantId(tenantId: string | number): number | null {
  const parsed =
    typeof tenantId === 'number' ? tenantId : Number.parseInt(String(tenantId).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/** Read `connected_count` off a result row, defaulting to 0 on anything odd. */
function readConnectedCount(result: { rows: unknown[] }): number {
  const row = result.rows?.[0] as { connected_count?: number | string } | undefined;
  if (!row) {
    return 0;
  }
  const value = row.connected_count;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Count connected Meta (facebook/instagram) channels in either store. */
export async function queryConnectedMetaPlatformCount(
  client: PlatformCountQueryable,
  tenantId: string | number,
): Promise<number> {
  const numericTenantId = toPositiveTenantId(tenantId);
  if (numericTenantId === null) {
    return 0;
  }
  const result = await client.query(COUNT_CONNECTED_META_PLATFORMS_SQL, [numericTenantId]);
  return readConnectedCount(result);
}

/**
 * Count connected channels among `platforms` (plus the legacy direct-Meta
 * store). Pass `publishablePlatforms()` — never a hand-rolled list.
 */
export async function queryConnectedPublishablePlatformCount(
  client: PlatformCountQueryable,
  tenantId: string | number,
  platforms: readonly string[],
): Promise<number> {
  const numericTenantId = toPositiveTenantId(tenantId);
  if (numericTenantId === null) {
    return 0;
  }
  const result = await client.query(COUNT_CONNECTED_PUBLISHABLE_PLATFORMS_SQL, [
    numericTenantId,
    [...platforms],
  ]);
  return readConnectedCount(result);
}
