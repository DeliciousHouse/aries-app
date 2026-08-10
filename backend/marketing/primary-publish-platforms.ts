/**
 * Which platforms does THIS tenant's weekly run publish to as its PRIMARY
 * targets? (AA-217)
 *
 * CONTRACT — why this exists:
 * Synthesis has always created facebook/instagram rows as the primary output of
 * a weekly run, with x/linkedin/reddit added only as an ADDITIONAL fan-out
 * mirroring an existing FB/IG feed image (`weekly-crosspost.ts`). A tenant with
 * no Meta connection therefore produced either nothing publishable or rows that
 * could only fail — which is why a LinkedIn-first prospect could not get a
 * week of content at all (AA-168, tenants 69/70).
 *
 * This module answers the one question that unblocks them: does the run take
 * the legacy Meta-primary path, or does it re-target the week's content at the
 * platforms the tenant actually has?
 *
 *   - `meta`      — at least one connected facebook/instagram channel in either
 *                   store. EVERY existing tenant. The legacy path runs
 *                   untouched; this resolution exists only to say "don't
 *                   change anything".
 *   - `alternate` — no Meta at all, but >= 1 connected, flag-enabled,
 *                   fully-configured crosspost platform. The week's content is
 *                   synthesized directly onto those platforms.
 *   - `none`      — nothing connected. Defensive: the publish gate blocks these
 *                   tenants upstream, but the gate fails OPEN on DB errors, so
 *                   synthesis keeps its own backstop rather than manufacturing
 *                   rows for a tenant with nowhere to send them.
 *
 * SINGLE SOURCE OF TRUTH: the alternate list is produced by
 * `resolveCrosspostPlatforms` — the exact function, query and flag/config
 * predicates the crosspost fan-out uses. There is no second "which platforms
 * are publishable" implementation here, so the gate, the fan-out and this
 * resolver cannot drift apart into "gate passed but zero rows synthesized".
 */

import {
  queryConnectedMetaPlatformCount,
  type PlatformCountQueryable,
} from '@/lib/connected-platform-counts';
import pool from '@/lib/db';

import {
  resolveCrosspostPlatforms,
  type CrosspostPlatform,
  type CrosspostQueryable,
} from './weekly-crosspost';

export type PrimaryPlatformResolution =
  | { mode: 'meta' }
  | { mode: 'alternate'; platforms: CrosspostPlatform[] }
  | { mode: 'none' };

type Env = Partial<Record<string, string | undefined>>;

/**
 * Resolve the primary publish platforms for a tenant.
 *
 * Meta ALWAYS wins when any facebook/instagram connection exists in either
 * store, including the legacy direct-Meta `oauth_connections` rows — a
 * direct-Meta tenant with no `connected_accounts` row must still resolve
 * `meta`, or its week would be re-targeted away from the channel it publishes
 * on today.
 *
 * The alternate branch, by contrast, reads `connected_accounts` ONLY (via
 * `resolveCrosspostPlatforms`). That is not an oversight about where non-Meta
 * rows live — `oauth_connections` really does hold stale non-Meta rows from
 * earlier connect flows (tenant 17: `linkedin|connected`) — it is because the
 * Composio publisher resolves a connection from `connected_accounts` alone, so
 * those rows cannot dispatch a post and must not re-target a week onto them.
 *
 * FAIL-OPEN, DELIBERATELY: if the Meta lookup throws we return `{mode:'meta'}`.
 * That is the choice that cannot regress the ~100% of tenants who are Meta —
 * a transient DB blip must never re-target their week. The cost is real and
 * accepted: for a non-Meta tenant the same blip fabricates Meta mode, so the
 * run synthesizes fb/ig rows that will fail at dispatch and that week's
 * linkedin/x posts are lost. It is logged at ERROR level for exactly that
 * reason — it is an incident for alternate-mode tenants, not a warning — and
 * the tenant-70 canary watches for it. Synthesis is replay-safe (every row
 * carries an ON CONFLICT idempotency key), so re-running the callback after the
 * blip recovers produces the correct rows.
 */
export async function resolvePrimaryPublishPlatforms(
  tenantId: number,
  db: CrosspostQueryable = pool,
  env: Env = process.env,
): Promise<PrimaryPlatformResolution> {
  let metaCount = 0;
  try {
    metaCount = await queryConnectedMetaPlatformCount(
      db as unknown as PlatformCountQueryable,
      tenantId,
    );
  } catch (err) {
    console.error(
      '[primary-publish-platforms] meta connection lookup failed — falling back to meta mode; ' +
        'an alternate-platform tenant loses this week and will synthesize undeliverable Meta rows',
      {
        tenantId,
        error: (err as Error)?.message ?? String(err),
      },
    );
    return { mode: 'meta' };
  }

  if (metaCount > 0) {
    return { mode: 'meta' };
  }

  // No Meta. Reuse the crosspost resolver verbatim: same connected_accounts
  // query, same status='connected' filter, same flag + config predicates, same
  // CROSSPOST_PLATFORMS ordering. It fails open to [] on a DB error, which
  // lands us in 'none' — no rows rather than undeliverable rows.
  const platforms = await resolveCrosspostPlatforms(tenantId, db, env);
  if (platforms.length === 0) {
    return { mode: 'none' };
  }
  return { mode: 'alternate', platforms };
}
