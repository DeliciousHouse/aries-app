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
 * is OFF — and its text is deliberately frozen: the `oauth_connections` branch
 * only ever holds direct-Meta OAuth rows, so it keeps the literal
 * `IN ('facebook','instagram')` rather than a parameterized list.
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
 * The `oauth_connections` branch is byte-identical to the Meta query above —
 * that store is direct-Meta only, so parameterizing it would change nothing but
 * could only introduce drift. The `connected_accounts` branch (authoritative)
 * widens to `platform = ANY($2)`, where `$2` is `publishablePlatforms()`.
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
            AND platform = ANY($2))
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
