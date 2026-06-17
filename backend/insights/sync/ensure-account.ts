/**
 * backend/insights/sync/ensure-account.ts
 *
 * Bridge: connected_accounts (the integration/Composio connection store) →
 * insights_accounts (what the sync worker fans out over).
 *
 * Nothing else inserts into insights_accounts, so without this bridge the sync
 * worker's `SELECT DISTINCT tenant_id FROM insights_accounts` is always empty
 * and the whole analytics pipeline no-ops even though a tenant has a connected
 * Facebook account. This runs once per worker tick and idempotently upserts one
 * insights_accounts row per tenant that has a connected, Composio-backed
 * Facebook connection (mapping connected_accounts.external_account_id → the
 * page id stored in insights_accounts.external_account_id).
 *
 * Instagram is intentionally out of scope (#596/#597 are Facebook-only); add
 * platforms to BRIDGED_PLATFORMS when their adapter lands.
 */

import pool from '@/lib/db';
import type { Queryable } from '@/backend/integrations/composio/connection-store';

/** Platforms whose Composio connections should be projected into insights_accounts. */
export const BRIDGED_PLATFORMS = ['facebook'] as const;

interface BridgeRow {
  tenant_id: string | number;
  platform: string;
  external_account_id: string;
  external_account_name: string | null;
}

export interface EnsureAccountsResult {
  /** Number of connected source connections considered. */
  considered: number;
  /** Number of insights_accounts rows upserted (inserted or refreshed). */
  upserted: number;
}

/**
 * Idempotently upsert insights_accounts rows from connected Composio
 * connections. Safe to call every tick: the UNIQUE (tenant_id, platform,
 * external_account_id) constraint collapses re-runs onto the existing row.
 */
export async function ensureInsightsAccountsForConnectedPlatforms(
  db: Queryable = pool,
): Promise<EnsureAccountsResult> {
  const placeholders = BRIDGED_PLATFORMS.map((_, i) => `$${i + 1}`).join(', ');
  const sources = await db.query<BridgeRow>(
    `SELECT tenant_id, platform, external_account_id, external_account_name
       FROM connected_accounts
      WHERE status = 'connected'
        AND connected_account_id IS NOT NULL
        AND external_account_id IS NOT NULL
        AND platform IN (${placeholders})`,
    [...BRIDGED_PLATFORMS],
  );

  let upserted = 0;
  for (const row of sources.rows) {
    const res = await db.query(
      `INSERT INTO insights_accounts (tenant_id, platform, external_account_id, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, platform, external_account_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, insights_accounts.display_name)`,
      [row.tenant_id, row.platform, row.external_account_id, row.external_account_name],
    );
    upserted += res.rowCount ?? 0;
  }

  return { considered: sources.rows.length, upserted };
}
