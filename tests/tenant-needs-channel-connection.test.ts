/**
 * AA-217 — the publish gate's verdict, per platform, per flag state.
 *
 * The owner directive is "all platforms need to not be blocked", and the live
 * proof of the bug is tenant 70 (Mission Booster Procurement): a single
 * `linkedin|connected` row in `connected_accounts`, zero posts ever, every
 * weekly run dying at the Stage 4 publish gate with `needs_connection`.
 *
 * These tests drive the REAL counters through a fake queryable that answers the
 * connection-count SQL the way the live DB would for a given set of connected
 * platforms, so they assert the actual gate verdict rather than a stub's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OnboardingGateQueryable } from '../lib/onboarding-gate';
import { tenantNeedsChannelConnection } from '../lib/tenant-needs-channel-connection';

type ConnectedRow = { platform: string; status: string };

/**
 * A queryable that answers BOTH connection-count queries the way Postgres
 * would: the oauth_connections branch counts nothing (no direct-Meta rows in
 * these scenarios) and the connected_accounts branch counts the rows whose
 * status is 'connected' and whose platform is in scope. Meta scope is the
 * literal fb/ig list; the publishable query passes its list as $2.
 */
function connectionsQueryable(rows: ConnectedRow[]): OnboardingGateQueryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const scoped = sql.includes('platform = ANY($2)')
        ? ((params[1] as string[]) ?? [])
        : ['facebook', 'instagram'];
      const count = rows.filter(
        (r) => r.status === 'connected' && scoped.includes(r.platform),
      ).length;
      return { rows: [{ connected_count: count }], rowCount: 1 };
    },
  } as unknown as OnboardingGateQueryable;
}

const MANAGED_ENVS = [
  'ARIES_ANY_PLATFORM_PUBLISH_ENABLED',
  'ARIES_X_ENABLED',
  'ARIES_LINKEDIN_ENABLED',
  'ARIES_REDDIT_ENABLED',
  'ARIES_YOUTUBE_ENABLED',
  'COMPOSIO_REDDIT_TARGET_SUBREDDIT',
  'COMPOSIO_X_PUBLISH_POST_ACTION',
  'COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION',
  'COMPOSIO_REDDIT_PUBLISH_POST_ACTION',
] as const;

/**
 * Mirrors the live app container (verified against its resolved env): every
 * platform rollout flag on, every COMPOSIO_<P>_PUBLISH_POST_ACTION slug set,
 * and COMPOSIO_REDDIT_TARGET_SUBREDDIT still EMPTY. The slugs belong in this
 * baseline because a platform without one cannot publish at all — the gate
 * excludes it, which is what the dedicated slug tests below assert.
 */
const LIVE_PLATFORM_FLAGS = {
  ARIES_X_ENABLED: 'true',
  ARIES_LINKEDIN_ENABLED: 'true',
  ARIES_REDDIT_ENABLED: 'true',
  COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
  COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  COMPOSIO_REDDIT_PUBLISH_POST_ACTION: 'REDDIT_CREATE_REDDIT_POST',
} as const;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  return async () => {
    const prev = MANAGED_ENVS.map((k) => [k, process.env[k]] as const);
    for (const k of MANAGED_ENVS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Flag OFF — the legacy verdict must be preserved exactly.
// ---------------------------------------------------------------------------

test(
  'flag OFF: a LinkedIn-only tenant is still blocked (legacy verdict preserved)',
  withEnv(LIVE_PLATFORM_FLAGS, async () => {
    const client = connectionsQueryable([{ platform: 'linkedin', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 70), true);
  }),
);

test(
  'flag OFF: a Meta tenant is unblocked, exactly as today',
  withEnv(LIVE_PLATFORM_FLAGS, async () => {
    const client = connectionsQueryable([{ platform: 'facebook', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 15), false);
  }),
);

// ---------------------------------------------------------------------------
// Flag ON — every connected platform unblocks.
// ---------------------------------------------------------------------------

const ON = { ...LIVE_PLATFORM_FLAGS, ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' };

test(
  'flag ON: a LinkedIn-only tenant is UNBLOCKED (tenant 70, the AA-168 report)',
  withEnv(ON, async () => {
    const client = connectionsQueryable([{ platform: 'linkedin', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 70), false);
  }),
);

test(
  'flag ON: an X-only tenant is unblocked',
  withEnv(ON, async () => {
    const client = connectionsQueryable([{ platform: 'x', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 71), false);
  }),
);

test(
  'flag ON: a Reddit-only tenant is unblocked ONLY when a target subreddit is configured',
  withEnv({ ...ON, COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test' }, async () => {
    const client = connectionsQueryable([{ platform: 'reddit', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 72), false);
  }),
);

test(
  'flag ON: a Reddit-only tenant stays BLOCKED while COMPOSIO_REDDIT_TARGET_SUBREDDIT is unset (live config)',
  withEnv(ON, async () => {
    // Every reddit row the producer could synthesize would fail terminally at
    // dispatch, so the gate must not open on reddit alone. This is the live
    // deployment's actual state.
    const client = connectionsQueryable([{ platform: 'reddit', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 72), true);
  }),
);

test(
  'flag ON: a Meta tenant is still unblocked (superset — no Meta verdict can change)',
  withEnv(ON, async () => {
    const client = connectionsQueryable([{ platform: 'instagram', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 15), false);
  }),
);

test(
  'flag ON: a tenant with ZERO connections is still BLOCKED (tenant 69)',
  withEnv(ON, async () => {
    const client = connectionsQueryable([]);
    assert.equal(await tenantNeedsChannelConnection(client, 69), true);
  }),
);

test(
  'flag ON: a PENDING connection does not unblock',
  withEnv(ON, async () => {
    const client = connectionsQueryable([
      { platform: 'linkedin', status: 'pending' },
      { platform: 'x', status: 'pending' },
    ]);
    assert.equal(await tenantNeedsChannelConnection(client, 73), true);
  }),
);

test(
  'flag ON: a connected platform whose rollout flag is OFF does not unblock',
  withEnv({ ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' }, async () => {
    // No ARIES_LINKEDIN_ENABLED: the deployment cannot publish LinkedIn at all,
    // so counting it would open the gate onto an empty week.
    const client = connectionsQueryable([{ platform: 'linkedin', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 70), true);
  }),
);

test(
  'flag ON: a connected platform with no publish action slug does not unblock',
  withEnv(
    {
      ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1',
      ARIES_LINKEDIN_ENABLED: 'true',
      // COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION deliberately unset. This is a
      // REACHABLE deployment shape: docker-compose declares the slug with an
      // empty default and connect-time preflight only WARNS about a missing
      // one, so a tenant can hold a `connected` LinkedIn row on a host that
      // cannot dispatch a single LinkedIn post. Opening the gate here would
      // synthesize a full week of posts that fail terminally, every week.
    },
    async () => {
      const client = connectionsQueryable([{ platform: 'linkedin', status: 'connected' }]);
      assert.equal(await tenantNeedsChannelConnection(client, 70), true);
    },
  ),
);

test(
  'flag ON: youtube does not unblock (deliberately excluded from v1 — see AA-217)',
  withEnv({ ...ON, ARIES_YOUTUBE_ENABLED: 'true' }, async () => {
    const client = connectionsQueryable([{ platform: 'youtube', status: 'connected' }]);
    assert.equal(await tenantNeedsChannelConnection(client, 74), true);
  }),
);

test(
  'an explicit counter override still wins over the flag (test seam intact)',
  withEnv(ON, async () => {
    const client = connectionsQueryable([]);
    assert.equal(await tenantNeedsChannelConnection(client, 69, async () => 3), false);
  }),
);
