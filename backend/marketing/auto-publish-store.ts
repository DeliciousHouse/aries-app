/**
 * `marketing_auto_publish_settings` — single writer.
 *
 * One row per tenant that has opted into autonomous DELIVERY. Auto-schedule is
 * unaffected and stays on for every tenant; this row decides only whether
 * `scheduled-posts-worker` may dispatch a due `scheduled_posts` row to the
 * provider, or whether it is held for a human to publish. See
 * `backend/marketing/auto-publish-env.ts` for the fleet-wide kill switch and
 * `scripts/automations/scheduled-posts-worker.mjs` (AUTO_PUBLISH_ADMIT_SQL) for
 * the enforcement point.
 *
 * ABSENCE == DISABLED, deliberately. The worker's admit predicate is
 * `EXISTS (... AND enabled)`, so a tenant with no row is held rather than
 * published. A missing row and an explicit `enabled=false` are the same answer;
 * the reader below normalizes both to `enabled: false` so no caller has to
 * special-case a null.
 *
 * `db` is a structural type (`.query(text, params)`), so both `pg.Pool` and
 * `pg.PoolClient` satisfy it. This module NEVER opens its own connection —
 * callers own connection lifecycle, matching `schedule-store.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AutoPublishQueryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type AutoPublishSetting = {
  tenantId: number;
  enabled: boolean;
  updatedByUserId: number | null;
  updatedAt: string | null;
};

const SELECT_SQL = `SELECT tenant_id, enabled, updated_by_user_id, updated_at
     FROM marketing_auto_publish_settings
    WHERE tenant_id = $1`;

// Upsert rather than UPDATE: the first time an admin flips the toggle there is
// no row yet (absence == disabled), so a plain UPDATE would silently no-op and
// report success while the tenant stayed held.
const UPSERT_SQL = `INSERT INTO marketing_auto_publish_settings
       (tenant_id, enabled, updated_by_user_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET enabled            = EXCLUDED.enabled,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at         = NOW()
     RETURNING tenant_id, enabled, updated_by_user_id, updated_at`;

function normalizeRow(row: Record<string, unknown> | undefined, tenantId: number): AutoPublishSetting {
  if (!row) {
    return { tenantId, enabled: false, updatedByUserId: null, updatedAt: null };
  }
  const updatedAt = row.updated_at;
  return {
    tenantId: Number(row.tenant_id),
    enabled: row.enabled === true,
    updatedByUserId: row.updated_by_user_id == null ? null : Number(row.updated_by_user_id),
    updatedAt:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : typeof updatedAt === 'string'
          ? updatedAt
          : null,
  };
}

/**
 * Read a tenant's auto-publish opt-in. An unseeded tenant reads back as
 * `enabled: false` (held), never null — same answer the worker's admit
 * predicate gives.
 */
export async function getAutoPublishSettingForTenant(
  db: AutoPublishQueryable,
  tenantId: number,
): Promise<AutoPublishSetting> {
  const result = await db.query(SELECT_SQL, [tenantId]);
  return normalizeRow(result.rows?.[0], tenantId);
}

/**
 * Set a tenant's auto-publish opt-in. Callers MUST have already checked that
 * the actor is a `tenant_admin` — this module does not enforce authorization
 * (matching `schedule-store.ts`, where the route handler owns the role guard).
 */
export async function setAutoPublishEnabledForTenant(
  db: AutoPublishQueryable,
  input: { tenantId: number; enabled: boolean; updatedByUserId: number | null },
): Promise<AutoPublishSetting> {
  const result = await db.query(UPSERT_SQL, [
    input.tenantId,
    input.enabled,
    input.updatedByUserId,
  ]);
  return normalizeRow(result.rows?.[0], input.tenantId);
}
