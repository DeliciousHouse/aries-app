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
  /** insights_accounts rows disabled by the orphan sweep this tick. */
  disabled: number;
  /** insights_accounts rows re-enabled because their connection came back. */
  reenabled: number;
  /** Set when the bridge no-opped because the off-switch is off. */
  skippedReason?: string;
}

/**
 * The one predicate that decides whether an insights_accounts row still has a
 * live connection behind it. Written once and referenced by BOTH sweep halves
 * so they can never disagree and leave a row flapping between disabled and
 * enabled on alternating ticks.
 *
 * `ca.external_account_id = ia.external_account_id` is the load-bearing part:
 * connected_accounts is UNIQUE (tenant_id, platform), so reconnecting to a
 * different Page/IG id REWRITES that row while the bridge inserts a NEW
 * insights_accounts row — the old one still matches on (tenant, platform) and
 * only the external id exposes it as dead.
 */
const HAS_LIVE_CONNECTION = `
  EXISTS (
    SELECT 1 FROM connected_accounts ca
     WHERE ca.tenant_id = ia.tenant_id
       AND ca.platform  = ia.platform
       AND ca.status    = 'connected'
       AND ca.provider  = 'composio'
       AND ca.external_account_id = ia.external_account_id
  )`;

/**
 * Disable insights_accounts rows that no longer have a matching connection.
 *
 * TWO rot mechanisms, both covered, distinguished by `disabled_reason`:
 *   - 'no_matching_connected_account' — a connected_accounts row for this
 *     (tenant, platform) still exists but points at a DIFFERENT external id
 *     (the reconnect case).
 *   - 'connected_account_deleted' — no connected_accounts row exists at all.
 *     Disconnect DELETEs the row (connection-store.ts deleteConnectionRow), so
 *     an "a row must exist" guard would exclude exactly this case and leave the
 *     orphan failing every tick forever.
 *
 * Highest-blast-radius statement in the module — nothing has ever deleted from
 * insights_accounts. Four guards: it only runs when the sources read returned
 * rows (never act on an empty/failed read), it is scoped to bridged platforms
 * (a platform whose flag is off is untouched, not disabled), it only ever sets
 * a timestamp (no DELETE), and it is fully reversed by REENABLE_ORPHANS_SQL on
 * the next tick after a reconnect.
 */
const DISABLE_ORPHANS_SQL = `
  UPDATE insights_accounts ia
     SET disabled_at = now(),
         disabled_reason = CASE
           WHEN EXISTS (
             SELECT 1 FROM connected_accounts ca
              WHERE ca.tenant_id = ia.tenant_id AND ca.platform = ia.platform
           ) THEN 'no_matching_connected_account'
           ELSE 'connected_account_deleted'
         END
   WHERE ia.platform = ANY($1::text[])
     AND ia.disabled_at IS NULL
     AND NOT ${HAS_LIVE_CONNECTION}
`;

/** Reverse of the sweep: a reconnect to the original id heals the row. */
const REENABLE_ORPHANS_SQL = `
  UPDATE insights_accounts ia
     SET disabled_at = NULL, disabled_reason = NULL
   WHERE ia.platform = ANY($1::text[])
     AND ia.disabled_at IS NOT NULL
     AND ${HAS_LIVE_CONNECTION}
`;

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
    return {
      considered: 0, upserted: 0, resolved: 0, skippedNoPage: 0,
      disabled: 0, reenabled: 0,
      skippedReason: 'no_enabled_analytics_platforms',
    };
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

  // ── Orphan sweep ────────────────────────────────────────────────────────
  // Runs ONLY when the sources read returned rows. An empty read is
  // indistinguishable from a transient failure or a mis-scoped filter, and
  // acting on it would disable every analytics account in the deployment.
  let disabled = 0;
  let reenabled = 0;
  if (sources.rows.length > 0) {
    try {
      const off = await db.query(DISABLE_ORPHANS_SQL, [platforms]);
      disabled = off.rowCount ?? 0;
      if (disabled > 0) log({ event: 'insights_account_disabled', count: disabled, platforms });
    } catch (err) {
      // A sweep failure must never cost the tenants their sync window — the
      // bridge's upserts above have already committed.
      log({ event: 'insights_account_sweep_failed', phase: 'disable', error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const on = await db.query(REENABLE_ORPHANS_SQL, [platforms]);
      reenabled = on.rowCount ?? 0;
      if (reenabled > 0) log({ event: 'insights_account_reenabled', count: reenabled, platforms });
    } catch (err) {
      log({ event: 'insights_account_sweep_failed', phase: 'reenable', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { considered: sources.rows.length, upserted, resolved, skippedNoPage, disabled, reenabled };
}
