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
 * Page-id back-heal: the Facebook Page id is not part of the Composio connection
 * metadata, so legacy rows can have `external_account_id IS NULL` (the prod
 * 2026-06-04 connection). For such rows the bridge resolves the Page id from
 * Composio (FACEBOOK_LIST_MANAGED_PAGES) using the connection's
 * connected_account_id, persists it back to connected_accounts so it is captured
 * once, then upserts insights_accounts. Resolution is fail-safe: an error or no
 * Page logs + skips that tenant — never throws (the worker tick must not wedge).
 *
 * Instagram is intentionally out of scope (#596/#597 are Facebook-only); add
 * platforms to BRIDGED_PLATFORMS when their adapter lands.
 */

import pool from '@/lib/db';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { analyticsProviderSelector } from '@/backend/integrations/providers/integration-config';
import { resolveComposioConfig, type ComposioConfig } from '@/backend/integrations/composio/composio-config';
import { createComposioGateway, type ComposioGateway } from '@/backend/integrations/composio/composio-client';
import { resolveFacebookManagedPage } from '@/backend/integrations/composio/facebook-page-resolver';

/** Platforms whose Composio connections should be projected into insights_accounts. */
export const BRIDGED_PLATFORMS = ['facebook'] as const;

interface BridgeRow {
  id: string | number;
  tenant_id: string | number;
  platform: string;
  external_account_id: string | null;
  external_account_name: string | null;
  connected_account_id: string | null;
}

export interface EnsureAccountsResult {
  /** Number of connected source connections considered. */
  considered: number;
  /** Number of insights_accounts rows upserted (inserted or refreshed). */
  upserted: number;
  /** Number of rows whose Page id was resolved from Composio + back-healed. */
  resolved: number;
  /** Rows skipped because their Page id could not be resolved. */
  skippedNoPage: number;
  /** Set when the bridge no-opped because the off-switch is off. */
  skippedReason?: string;
}

/** Injectable Composio surface so tests drive resolution with a fake gateway. */
export interface EnsureAccountsDeps {
  gateway?: ComposioGateway;
  config?: ComposioConfig | null;
}

function log(obj: Record<string, unknown>): void {
  // NDJSON, same shape the worker emits, so log aggregators key on `event`.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

/**
 * Idempotently upsert insights_accounts rows from connected Composio
 * connections. Safe to call every tick: the UNIQUE (tenant_id, platform,
 * external_account_id) constraint collapses re-runs onto the existing row.
 *
 * Gated by the same off-switch as the adapter (ANALYTICS_PROVIDER=composio):
 * when analytics is not on Composio this is a no-op, so nothing is populated and
 * the worker stays a clean no-op (no failed sync runs for a disabled path).
 */
export async function ensureInsightsAccountsForConnectedPlatforms(
  db: Queryable = pool,
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsureAccountsDeps = {},
): Promise<EnsureAccountsResult> {
  if (analyticsProviderSelector(env) !== 'composio') {
    return { considered: 0, upserted: 0, resolved: 0, skippedNoPage: 0, skippedReason: 'analytics_provider_not_composio' };
  }

  const placeholders = BRIDGED_PLATFORMS.map((_, i) => `$${i + 1}`).join(', ');
  // NOTE: external_account_id is intentionally NOT filtered here — a null Page id
  // is back-healed below rather than skipped (the prod connection data gap).
  const sources = await db.query<BridgeRow>(
    `SELECT id, tenant_id, platform, external_account_id, external_account_name, connected_account_id
       FROM connected_accounts
      WHERE status = 'connected'
        AND provider = 'composio'
        AND connected_account_id IS NOT NULL
        AND platform IN (${placeholders})`,
    [...BRIDGED_PLATFORMS],
  );

  // Build the Composio gateway lazily — only when a row actually needs Page-id
  // resolution, and only once. A null config (no API key) means resolution is
  // unavailable; such rows are skipped fail-safe.
  let resolverDeps: { gateway: ComposioGateway; config: ComposioConfig } | null | undefined;
  const getResolver = (): { gateway: ComposioGateway; config: ComposioConfig } | null => {
    if (resolverDeps !== undefined) return resolverDeps;
    const config = deps.config !== undefined ? deps.config : resolveComposioConfig(env);
    if (!config) {
      resolverDeps = null;
      return null;
    }
    try {
      const gateway = deps.gateway ?? createComposioGateway(config);
      resolverDeps = { gateway, config };
    } catch {
      resolverDeps = null;
    }
    return resolverDeps;
  };

  let upserted = 0;
  let resolved = 0;
  let skippedNoPage = 0;

  for (const row of sources.rows) {
    let pageId = row.external_account_id?.trim() || null;
    let pageName = row.external_account_name;

    if (!pageId) {
      // Back-heal: resolve the Page id from Composio and persist it once.
      const r = getResolver();
      if (!r || !row.connected_account_id) {
        skippedNoPage++;
        log({ event: 'insights_bridge_page_unresolved', tenantId: row.tenant_id, reason: r ? 'no_connected_account' : 'composio_unavailable' });
        continue;
      }
      let page: Awaited<ReturnType<typeof resolveFacebookManagedPage>> = null;
      try {
        page = await resolveFacebookManagedPage(r.gateway, r.config, row.connected_account_id);
      } catch (err) {
        page = null;
        log({ event: 'insights_bridge_page_resolve_error', tenantId: row.tenant_id, error: err instanceof Error ? err.message : String(err) });
      }
      if (!page) {
        skippedNoPage++;
        log({ event: 'insights_bridge_page_unresolved', tenantId: row.tenant_id, reason: 'no_managed_page' });
        continue;
      }
      pageId = page.pageId;
      pageName = pageName ?? page.pageName;
      // Persist back so the Page id is captured once (future ticks skip resolution).
      await db.query(
        `UPDATE connected_accounts
           SET external_account_id = $1,
               external_account_name = COALESCE($2, external_account_name),
               updated_at = now()
         WHERE id = $3`,
        [pageId, page.pageName, row.id],
      );
      resolved++;
      log({ event: 'insights_bridge_page_resolved', tenantId: row.tenant_id, pageId, managedCount: page.managedCount });
    }

    const res = await db.query(
      `INSERT INTO insights_accounts (tenant_id, platform, external_account_id, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, platform, external_account_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, insights_accounts.display_name)`,
      [row.tenant_id, row.platform, pageId, pageName],
    );
    upserted += res.rowCount ?? 0;
  }

  return { considered: sources.rows.length, upserted, resolved, skippedNoPage };
}
