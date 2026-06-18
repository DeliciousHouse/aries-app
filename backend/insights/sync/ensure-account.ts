/**
 * backend/insights/sync/ensure-account.ts
 *
 * Bridge: connected_accounts (the integration/Composio connection store) →
 * insights_accounts (what the sync worker fans out over).
 *
 * Nothing else inserts into insights_accounts, so without this bridge the sync
 * worker's `SELECT DISTINCT tenant_id FROM insights_accounts` is always empty
 * and the whole analytics pipeline no-ops even though a tenant has a connected
 * account. This runs once per worker tick and idempotently upserts one
 * insights_accounts row per tenant that has a connected, Composio-backed
 * connection (mapping connected_accounts.external_account_id → the platform
 * account id stored in insights_accounts.external_account_id).
 *
 * External-id back-heal: the external account id is not part of the Composio
 * connection metadata for several platforms, so legacy rows can have
 * `external_account_id IS NULL`. For such rows the bridge resolves the id from
 * Composio using the connection's connected_account_id, persists it back to
 * connected_accounts so it is captured once, then upserts insights_accounts.
 * Resolution is fail-safe: an error or no result logs + skips that tenant —
 * never throws (the worker tick must not wedge).
 *
 * Resolver per platform:
 *   facebook  → FACEBOOK_LIST_MANAGED_PAGES       → page id
 *   instagram → INSTAGRAM_GET_USER_INFO ('me')     → ig user id + username (#692/#693)
 *   youtube   → YOUTUBE_LIST_CHANNELS             → channel id
 *   x         → TWITTER_USER_LOOKUP_ME            → username/handle (#670)
 *   reddit    → REDDIT_GET_REDDIT_USER_ABOUT      → username (#670)
 *   linkedin  → no back-heal (URN resolved at connect via ensure-linkedin-urn.ts)
 *
 * Instagram is now bridged (#692/#693): both facebook and instagram are governed
 * by the ANALYTICS_PROVIDER=composio gate (no separate ARIES_INSTAGRAM_ENABLED
 * flag). Add platforms to BRIDGED_PLATFORMS when their adapter lands.
 */

import pool from '@/lib/db';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { isPlatformInsightsEnabled } from '@/backend/insights/sync/adapter-factory';
import { resolveComposioConfig, type ComposioConfig } from '@/backend/integrations/composio/composio-config';
import { createComposioGateway, type ComposioGateway } from '@/backend/integrations/composio/composio-client';
import { resolveFacebookManagedPage } from '@/backend/integrations/composio/facebook-page-resolver';
import { resolveInstagramAccount } from '@/backend/integrations/composio/instagram-account-resolver';
import { resolveYouTubeChannel } from '@/backend/integrations/composio/youtube-channel-resolver';
import { resolveXUser } from '@/backend/integrations/composio/x-user-resolver';
import { resolveRedditUser } from '@/backend/integrations/composio/reddit-user-resolver';

/**
 * Platforms bridged unconditionally when ANALYTICS_PROVIDER=composio. Both
 * facebook and instagram use the same ANALYTICS_PROVIDER gate (no separate
 * ARIES_INSTAGRAM_ENABLED flag). Exported for test introspection.
 * Composio-only platforms (x, youtube, reddit, linkedin) are NOT listed here
 * because they are conditional on both their rollout flag AND COMPOSIO_ENABLED —
 * they are included in the dynamic bridgedPlatforms() result only when both
 * conditions are met. See bridgedPlatforms() below.
 */
export const BRIDGED_PLATFORMS = ['facebook', 'instagram'] as const;

/**
 * Full bridged-platform list for this env, computed per-platform using the same
 * `is<P>InsightsEnabled` predicates as the adapter factory (via
 * isPlatformInsightsEnabled). The two can therefore never drift.
 *
 *   facebook  → bridged iff ANALYTICS_PROVIDER=composio
 *   instagram → bridged iff ANALYTICS_PROVIDER=composio (same gate as facebook)
 *   x         → bridged iff ARIES_X_ENABLED + COMPOSIO_ENABLED
 *   youtube   → bridged iff ARIES_YOUTUBE_ENABLED + COMPOSIO_ENABLED
 *   reddit    → bridged iff ARIES_REDDIT_ENABLED + COMPOSIO_ENABLED
 *   linkedin  → bridged iff ARIES_LINKEDIN_ENABLED + COMPOSIO_ENABLED
 */
function bridgedPlatforms(env: NodeJS.ProcessEnv): string[] {
  return ['facebook', 'instagram', 'x', 'youtube', 'reddit', 'linkedin'].filter(
    (p) => isPlatformInsightsEnabled(p, env),
  );
}

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
 * Gated per-platform by the same predicates the adapter factory uses (via
 * isPlatformInsightsEnabled), so the bridge and adapter selections can never
 * drift:
 *   - Facebook and Instagram are bridged only when ANALYTICS_PROVIDER=composio.
 *   - Composio-only platforms (x, youtube, reddit, linkedin) are bridged only
 *     when their rollout flag AND COMPOSIO_ENABLED are both on — independent of
 *     ANALYTICS_PROVIDER, which governs facebook/instagram only.
 * When no platform is enabled the function is a clean no-op (no DB query issued).
 */
export async function ensureInsightsAccountsForConnectedPlatforms(
  db: Queryable = pool,
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsureAccountsDeps = {},
): Promise<EnsureAccountsResult> {
  const platforms = bridgedPlatforms(env);
  if (platforms.length === 0) {
    return { considered: 0, upserted: 0, resolved: 0, skippedNoPage: 0, skippedReason: 'no_enabled_analytics_platforms' };
  }
  const placeholders = platforms.map((_, i) => `$${i + 1}`).join(', ');
  // NOTE: external_account_id is intentionally NOT filtered here — a null Page id
  // is back-healed below rather than skipped (the prod connection data gap).
  const sources = await db.query<BridgeRow>(
    `SELECT id, tenant_id, platform, external_account_id, external_account_name, connected_account_id
       FROM connected_accounts
      WHERE status = 'connected'
        AND provider = 'composio'
        AND connected_account_id IS NOT NULL
        AND platform IN (${placeholders})`,
    platforms,
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
      // Back-heal is available for facebook, instagram, youtube, x, and reddit.
      // LinkedIn's URN is resolved at connect time via ensure-linkedin-urn.ts, so
      // a null id there is not back-heal-able here — skip and let a later
      // connect/re-auth populate it. Never invent an external account id.
      if (!['facebook', 'instagram', 'youtube', 'x', 'reddit'].includes(row.platform)) {
        skippedNoPage++;
        log({ event: 'insights_bridge_page_unresolved', tenantId: row.tenant_id, platform: row.platform, reason: 'no_external_account_id' });
        continue;
      }
      // Back-heal: resolve the external id from Composio and persist it once.
      const r = getResolver();
      if (!r || !row.connected_account_id) {
        skippedNoPage++;
        log({ event: 'insights_bridge_page_unresolved', tenantId: row.tenant_id, platform: row.platform, reason: r ? 'no_connected_account' : 'composio_unavailable' });
        continue;
      }
      // Each resolver is fail-safe (returns null, never throws); the catch is a
      // belt-and-braces guard so a single tenant can never wedge the worker tick.
      let resolvedId: string | null = null;
      let resolvedName: string | null = null;
      let resolvedManagedCount = 0;
      try {
        if (row.platform === 'youtube') {
          const channel = await resolveYouTubeChannel(r.gateway, r.config, row.connected_account_id);
          if (channel) {
            resolvedId = channel.channelId;
            resolvedName = channel.channelName;
            resolvedManagedCount = channel.managedCount;
          }
        } else if (row.platform === 'x') {
          // Resolve the X username (handle); stored as external_account_id so the
          // fetchComments `-from:<handle>` filter in the X adapter works correctly.
          const user = await resolveXUser(r.gateway, r.config, row.connected_account_id);
          if (user) {
            resolvedId = user.username;
            resolvedName = user.name;
            resolvedManagedCount = 1;
          }
        } else if (row.platform === 'reddit') {
          // Resolve the Reddit username; stored as external_account_id to satisfy
          // the NOT NULL enrollment column (the Reddit adapter is DB-driven and
          // never uses pageId, but the column must be non-null to enroll the row).
          const user = await resolveRedditUser(r.gateway, r.config, row.connected_account_id);
          if (user) {
            resolvedId = user.username;
            resolvedName = user.name;
            resolvedManagedCount = 1;
          }
        } else if (row.platform === 'instagram') {
          // Resolve the IG user id (numeric) via INSTAGRAM_GET_USER_INFO('me').
          // The 'me' resolution is UNVERIFIED live (IG is not connected yet as of
          // #692/#693); if it fails on first live connect, the fail-safe null just
          // skips this tenant — it never wedges the FB/X sync.
          const account = await resolveInstagramAccount(r.gateway, r.config, row.connected_account_id);
          if (account) {
            resolvedId = account.igUserId;
            resolvedName = account.username;
            resolvedManagedCount = 1;
          }
        } else {
          const page = await resolveFacebookManagedPage(r.gateway, r.config, row.connected_account_id);
          if (page) {
            resolvedId = page.pageId;
            resolvedName = page.pageName;
            resolvedManagedCount = page.managedCount;
          }
        }
      } catch (err) {
        resolvedId = null;
        log({ event: 'insights_bridge_page_resolve_error', tenantId: row.tenant_id, platform: row.platform, error: err instanceof Error ? err.message : String(err) });
      }
      if (!resolvedId) {
        skippedNoPage++;
        log({ event: 'insights_bridge_page_unresolved', tenantId: row.tenant_id, platform: row.platform, reason: 'no_managed_account' });
        continue;
      }
      pageId = resolvedId;
      pageName = pageName ?? resolvedName;
      // Persist back so the external id is captured once (future ticks skip resolution).
      await db.query(
        `UPDATE connected_accounts
           SET external_account_id = $1,
               external_account_name = COALESCE($2, external_account_name),
               updated_at = now()
         WHERE id = $3`,
        [pageId, resolvedName, row.id],
      );
      resolved++;
      log({ event: 'insights_bridge_page_resolved', tenantId: row.tenant_id, platform: row.platform, pageId, managedCount: resolvedManagedCount });
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
