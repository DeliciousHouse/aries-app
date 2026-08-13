/**
 * backend/insights/force-throttle.ts
 *
 * S7-2 / AA-120 (gap D2) — bounds the authenticated `?force=true` cache-bypass
 * path on the six cached insights sections (narrative, goal, attention,
 * activity, trends, top).
 *
 * WHAT A FORCED REQUEST ACTUALLY COSTS, read off the shipped handlers rather
 * than assumed: all six acquire a pooled client BEFORE they branch on `force`
 * (the `pool.connect()` sits above the `if (!force)` cache read in every one of
 * them), then run the full section builder on that client and upsert the
 * result. So one forced request costs a held pool connection for the entire
 * rebuild, the builder's six-to-nine statements on it, and a write.
 *
 * The CONCURRENT half of the threat is PARTLY bounded already, and it is worth
 * being precise about which part, because that is what decides the shape of
 * this file. AA-122's singleflight keys on `inputHash(tenantId, period,
 * platform)`, which has no `force` component, and forced requests call
 * `buildInsightsSectionOnce` on the same path as unforced ones — so N
 * simultaneous forces of one section collapse onto ONE build. Two costs survive
 * that collapse:
 *
 *   - the pooled client each request holds while awaiting the shared build.
 *     `DB_POOL_MAX` is 20 in the shipped compose profile and 10 in the
 *     guardrail #4 target, so a scripted burst still starves every other
 *     endpoint in the process — and because exhaustion surfaces first at the
 *     tenant lookup that every authenticated route performs, the blast radius
 *     is the whole app, not just /insights.
 *   - the upsert. Every follower runs its own `INSERT ... ON CONFLICT DO
 *     UPDATE` after inheriting the leader's snapshot, so N concurrent forces
 *     are 1 build but N writes to `insights_narratives`.
 *
 * And singleflight does nothing whatsoever for SERIAL hammering: the in-flight
 * entry is deleted in a `finally`, so sequential forces never overlap and each
 * one runs a complete builder and a fresh upsert.
 *
 * Hence the gate must run BEFORE `pool.connect()`. A throttle placed after the
 * client is acquired would still concede the exact resource it exists to
 * protect, which is why this module is deliberately synchronous and does no
 * I/O: it has to be callable before a connection exists.
 *
 * WHAT THIS DOES NOT ELIMINATE, stated plainly so the guarantee is not read as
 * broader than it is. Resolving the tenant is what makes a per-tenant bucket
 * possible, and `getTenantContext` takes its own brief pool checkout on every
 * authenticated request (`lib/tenant-context.ts`, acquired and released around
 * the lookup). A denied request therefore still costs that one short checkout —
 * the same one every authenticated route in the app pays. What the gate removes
 * is the expensive part: the connection HELD across the whole rebuild, the six
 * to nine builder statements on it, and the upsert. So the roadmap's "scripted
 * hammering doesn't reach the pool" holds for the rebuild path, not literally
 * for authentication. Bounding that too would mean throttling before identity
 * is known — i.e. on IP rather than tenant — which is a different control with
 * a different failure mode (shared egress IPs) and is not this ticket.
 *
 * WHY THE ALLOWANCE IS GENEROUS. `force=true` is reachable from the browser
 * through exactly one affordance: `<ErrorState onRetry={refetch} />`
 * (frontend/insights/useInsight.ts exposes `refetch` as `run(true)`, and every
 * consumer wires it only to an error state's retry button). There is no
 * "Refresh" control on the dashboard, nothing polls these six endpoints, and
 * useInsight never retries on its own. So the only human who ever sends a
 * forced request is one whose section already failed, clicking Retry — and
 * throttling that person is throttling the sole recovery path in the UI. The
 * shipped default of 5 forced rebuilds per section per 5 minutes is invisible
 * to a human mashing Retry while still cutting a 100-requests-per-second script
 * to 5 rebuilds per 5 minutes.
 *
 * THIS IS NOT A NEW IDIOM. `backend/marketing/posting-time-advisor.ts` already
 * establishes "force bypasses the freshness window but still honors a short
 * cooldown floor" (`FORCE_COOLDOWN_MINUTES = 2`, so "an admin looping the
 * 'update times now' button cannot fire back-to-back Hermes research runs").
 * The one place this deliberately diverges is where the counter lives: that
 * advisor uses a cross-process claim ROW (`marketing_posting_time_claims`),
 * which is right for it because the thing being protected is a minutes-long
 * Hermes research run — a Postgres round-trip to decide is negligible against
 * what it prevents. Here the protected operation is a sub-second cache rebuild
 * and the contended resource IS the connection pool, so paying a query to
 * decide whether to pay a query would be self-defeating.
 *
 * STATE IS PER-PROCESS, deliberately, matching the precedent cache-policy.ts
 * already set for its in-flight map ("Making it exact would need a
 * cross-process lock ... Not worth it at this profile"). Here the argument is
 * stronger, not merely equal: a cross-process counter would have to be read
 * from Postgres on the very path under contention, spending a connection to
 * decide whether to spend a connection. With `ARIES_WEB_CONCURRENCY` cluster
 * workers (2 in the shipped compose profile, 4 in the guardrail #4 target) an
 * attacker round-robining across them gets at most that multiple of the
 * allowance — so the worst case is 10-20 forced rebuilds per section per 5
 * minutes instead of 5. A bounded overshoot on an already ~1000x reduction, not
 * a hole.
 *
 * Note these endpoints are readable by every tenant role including
 * `tenant_viewer` (none of the six checks a role), so the limiter is the only
 * thing standing between a low-privilege session and the pool.
 */

import { NextResponse } from 'next/server';

/**
 * The sections that honor `force` and rebuild on a pooled client.
 *
 * The first six read the `insights_narratives` cache. The last three (S7-3 /
 * AA-121) read the in-process micro-cache instead, but they bypass it on
 * `force` and then rebuild through the same pool, so they present the identical
 * hazard and take the identical limiter. Adding a cached, force-honoring
 * section WITHOUT adding it here reopens AA-120 for that endpoint —
 * tests/insights-force-throttle.test.ts pins all ten so the omission fails CI
 * rather than shipping silently.
 */
export type CachedInsightsSection =
  | 'narrative'
  | 'goal'
  | 'attention'
  | 'activity'
  | 'trends'
  | 'top'
  | 'aries'
  | 'audience'
  | 'conversations'
  // AA-229/PR2b: Section 10 — Weekly Recap. Reads the micro-cache like
  // aries/audience/conversations, but rebuilds on a literal
  // `pool.connect()` in its own handler rather than through a builder that
  // opens its own client (matching Section 6/`top`'s pattern), so it needs
  // no entry in the BUILDER_SECTIONS list in
  // tests/insights-force-throttle.test.ts.
  | 'weekly-recap';

/** Forced rebuilds allowed per (tenant, section) per refill window. */
export const DEFAULT_FORCE_THROTTLE_CAPACITY = 5;

/** The window over which a fully drained bucket refills to capacity. */
export const DEFAULT_FORCE_THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

type Env = Partial<Record<string, string | undefined>>;

/**
 * Default ON, unlike most rollout flags in this repo, because a rate limit that
 * ships disabled protects nothing — the vulnerability it closes would stay open
 * until someone remembered to flip it. This is the kill switch for that
 * control, not the switch that turns it on. Anything that is not an explicit
 * falsy value leaves the limiter enabled, so a typo fails safe (limited) rather
 * than silently reopening the bypass.
 */
export function isInsightsForceThrottleEnabled(env: Env = process.env): boolean {
  const raw = env.ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED?.trim().toLowerCase();
  if (raw == null || raw === '') return true;
  if (FALSY.has(raw)) return false;
  if (TRUTHY.has(raw)) return true;
  return true;
}

/**
 * A non-positive or unparseable value falls back to the default. A capacity of
 * 0 would mean "deny every forced request", which is a footgun dressed as a
 * config value; disabling belongs to the flag above.
 *
 * Digits only, deliberately: `Number.parseInt('1e3', 10)` is 1, so a plain
 * parseInt would read an intended 1000 as a burst of ONE and throttle a healthy
 * deployment to near-nothing. CLAUDE.md records the same trap for
 * `parsePoolMax` (`1e2` must fall back rather than parse), so this follows the
 * documented repo behavior rather than the looser helper in
 * backend/telemetry/usage-rollup-env.ts.
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function forceThrottleCapacity(env: Env = process.env): number {
  return parsePositiveInt(env.ARIES_INSIGHTS_FORCE_THROTTLE_BURST, DEFAULT_FORCE_THROTTLE_CAPACITY);
}

export function forceThrottleWindowMs(env: Env = process.env): number {
  return parsePositiveInt(
    env.ARIES_INSIGHTS_FORCE_THROTTLE_WINDOW_MS,
    DEFAULT_FORCE_THROTTLE_WINDOW_MS,
  );
}

export interface ForceThrottleDecision {
  /** False means the caller must not proceed to `pool.connect()`. */
  allowed: boolean;
  /** Milliseconds until one token is available. 0 when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  /** Fractional tokens remaining; refilled lazily on read. */
  tokens: number;
  /** When `tokens` was last recomputed. */
  updatedAtMs: number;
}

/**
 * Module-level so every request in this process shares it. Keyed by
 * tenant AND section: the card specifies a per-tenant/section cooldown, and
 * that granularity is load-bearing rather than incidental — a single per-tenant
 * bucket would let one section's retries drain the allowance for the other
 * five, so a user retrying a broken Trends panel could lock themselves out of
 * retrying a broken Goal panel.
 *
 * The key deliberately stops there. It does NOT include `period` or `platform`,
 * even though both are part of the cache key, because neither is validated
 * before reaching this point — five of the six handlers simply lowercase
 * whatever `platform` string arrives. Keying on them would let a caller mint a
 * fresh full bucket per junk value (`platform=a`, `platform=b`, ...) and walk
 * straight around the limit. Coarser is the safe direction here: the worst a
 * legitimate user loses is that refreshing the same section across two periods
 * draws on one allowance.
 */
const BUCKETS = new Map<string, Bucket>();

/**
 * Entries are only created by forcing tenants, so the live key space is
 * (tenants that recently forced) x 6 — small. This cap exists so the map is
 * bounded by construction rather than by that argument holding forever.
 */
const MAX_BUCKETS = 10_000;

/**
 * Drop every bucket that has refilled to capacity. Such an entry is
 * indistinguishable from an absent one — a missing key is treated as a full
 * bucket — so this is a pure memory reclaim and can never grant or deny a
 * token that would otherwise have gone the other way.
 */
function pruneRefilledBuckets(nowMs: number, capacity: number, refillPerMs: number): void {
  for (const [key, bucket] of BUCKETS) {
    const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
    if (bucket.tokens + elapsedMs * refillPerMs >= capacity) {
      BUCKETS.delete(key);
    }
  }
}

/** Test seam — the map is process-global, so a test must be able to reset it. */
export function __resetInsightsForceThrottleForTests(): void {
  BUCKETS.clear();
}

/** Test seam — how many buckets are currently retained. */
export function __forceThrottleBucketCountForTests(): number {
  return BUCKETS.size;
}

function bucketKey(tenantId: number, section: CachedInsightsSection): string {
  return `${tenantId}|${section}`;
}

/**
 * Take one token for a forced rebuild of `section` on behalf of `tenantId`.
 *
 * Call this ONLY when `force` is true and ONLY before acquiring a pooled
 * client. Unforced requests are served from cache and must never consume a
 * token — they are not the path this bounds.
 *
 * `nowMs` is injectable so a cooldown can be tested without sleeping.
 */
export function consumeInsightsForceToken(
  tenantId: number,
  section: CachedInsightsSection,
  nowMs: number = Date.now(),
  env: Env = process.env,
): ForceThrottleDecision {
  if (!isInsightsForceThrottleEnabled(env)) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const capacity = forceThrottleCapacity(env);
  const windowMs = forceThrottleWindowMs(env);
  const refillPerMs = capacity / windowMs;

  const key = bucketKey(tenantId, section);
  const existing = BUCKETS.get(key);

  // An absent key is a full bucket: a tenant that has not forced this section
  // recently starts with the whole allowance.
  let tokens = capacity;
  if (existing) {
    const elapsedMs = Math.max(0, nowMs - existing.updatedAtMs);
    tokens = Math.min(capacity, existing.tokens + elapsedMs * refillPerMs);
  }

  if (tokens < 1) {
    // Retain the drained bucket and report honestly how long until one token.
    // Note this does NOT extend the cooldown on a denied attempt: `tokens` is
    // recomputed from elapsed time, so hammering while throttled cannot push
    // the recovery further out.
    BUCKETS.set(key, { tokens, updatedAtMs: nowMs });
    const retryAfterMs = Math.ceil((1 - tokens) / refillPerMs);
    return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
  }

  if (!existing && BUCKETS.size >= MAX_BUCKETS) {
    pruneRefilledBuckets(nowMs, capacity, refillPerMs);
  }

  BUCKETS.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * The 429 a throttled forced rebuild returns.
 *
 * Shape follows the one existing rate-limit response in this repo
 * (app/api/feedback/route.ts: `{ status: 'error', error: 'rate_limited' }`), so
 * a client that already understands one understands both. `retry_after_ms`
 * carries the real remaining cooldown rather than a fixed constant, and the
 * `Retry-After` header repeats it in whole seconds per RFC 9110 — rounded UP,
 * because a client that retries a fraction of a second early would be denied
 * again and reasonably conclude the limiter is lying.
 *
 * Deliberately NOT a body the section renderers will try to draw: a throttled
 * refresh must leave whatever the user is already looking at on screen
 * (useInsight keeps its previous `data` on a 429), not replace a populated
 * panel with an empty one.
 */
export function insightsForceThrottledResponse(decision: ForceThrottleDecision): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  return NextResponse.json(
    {
      status: 'error',
      error: 'rate_limited',
      retry_after_ms: decision.retryAfterMs,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * The whole gate, as one call, so the six handlers each gain three lines rather
 * than a copy of the policy. Returns a response to return, or null to proceed.
 *
 * MUST be called before `pool.connect()` — see the header comment. Returning
 * early here is what keeps a throttled request from ever holding a connection.
 */
export function checkInsightsForceThrottle(
  force: boolean,
  tenantId: number,
  section: CachedInsightsSection,
  nowMs: number = Date.now(),
  env: Env = process.env,
): NextResponse | null {
  if (!force) return null;
  const decision = consumeInsightsForceToken(tenantId, section, nowMs, env);
  if (decision.allowed) return null;
  return insightsForceThrottledResponse(decision);
}
