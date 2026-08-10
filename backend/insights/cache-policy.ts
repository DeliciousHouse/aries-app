/**
 * backend/insights/cache-policy.ts
 *
 * S7-4 / AA-122 (gaps D4/D5) — shared expiry + stampede policy for the six
 * cached insights sections (narrative, goal, attention, activity, trends, top).
 *
 * Two distinct problems, two distinct fixes:
 *
 *   Jitter solves ACROSS keys. Every section shared one flat 1h TTL, so the
 *   six rows a tenant's dashboard writes on its first load all expire in the
 *   same second an hour later — and so do every other tenant's, if they first
 *   loaded around the same time (a deploy, a morning standup). Spreading each
 *   key's expiry over a window turns one cliff into a ramp. The offset is
 *   DERIVED FROM THE KEY, not random: a random per-request TTL would let two
 *   concurrent requests disagree about whether the same row is stale, so a
 *   body could flip between fresh and expired on refresh.
 *
 *   Singleflight solves WITHIN a key. Jitter does nothing for N users of the
 *   same tenant hitting the same section at the same moment — they all miss,
 *   and all N run the full builder. Collapsing them onto one in-flight build
 *   is what bounds the work to one rebuild per section per expiry.
 *
 * Scope limit, stated plainly: the in-flight map is per PROCESS. With
 * `ARIES_WEB_CONCURRENCY` cluster workers a simultaneous expiry can still
 * produce up to that many rebuilds — not N. Making it exact would need a
 * cross-process lock (a Postgres advisory lock) held on the request path,
 * which trades a bounded, already-small overshoot for lock-wait latency and a
 * connection held while waiting. Not worth it at this profile.
 */

import crypto from 'crypto';

/** The base freshness window every cached section has always used. */
export const INSIGHTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Ceiling on the jitter window. Sections do not all share one base TTL —
 * attention is 15 minutes, the rest are an hour — so the spread is a fraction
 * of each section's own TTL rather than a flat number, which would be a 67%
 * swing on the 15-minute section and a 17% swing on the hourly ones.
 */
export const INSIGHTS_CACHE_JITTER_FRACTION = 0.1;
export const INSIGHTS_CACHE_MAX_JITTER_MS = 10 * 60 * 1000; // 10 minutes

/** The jitter window for a given base TTL: 10% of it, capped at 10 minutes. */
export function insightsCacheJitterMs(baseTtlMs: number = INSIGHTS_CACHE_TTL_MS): number {
  if (!Number.isFinite(baseTtlMs) || baseTtlMs <= 0) return 0;
  return Math.min(Math.floor(baseTtlMs * INSIGHTS_CACHE_JITTER_FRACTION), INSIGHTS_CACHE_MAX_JITTER_MS);
}

/**
 * Deterministic per-key TTL in `[baseTtlMs, baseTtlMs + jitter)`.
 *
 * Same key, same answer, forever — which is what keeps concurrent readers
 * agreeing about staleness. Different keys land on different offsets, which is
 * the whole point. Never returns less than the base TTL: jitter may only delay
 * an expiry, never bring one forward, so no section becomes fresher than the
 * freshness contract it documents.
 */
export function insightsCacheTtlMs(
  cacheKey: string,
  baseTtlMs: number = INSIGHTS_CACHE_TTL_MS,
): number {
  const jitter = insightsCacheJitterMs(baseTtlMs);
  if (jitter <= 0) return baseTtlMs;
  const digest = crypto.createHash('sha256').update(cacheKey).digest();
  // 32 bits is plenty of spread for a sub-hour window and avoids the sign and
  // precision questions that come with reading more.
  return baseTtlMs + (digest.readUInt32BE(0) % jitter);
}

/**
 * The in-flight builds, keyed exactly like the cache row they will produce.
 * Module-level so every request in this process shares it.
 */
const INFLIGHT = new Map<string, Promise<unknown>>();

/** Test seam — the map is process-global, so a test must be able to reset it. */
export function __resetInsightsInflightForTests(): void {
  INFLIGHT.clear();
}

/** Test seam — how many builds are currently in flight. */
export function __inflightCountForTests(): number {
  return INFLIGHT.size;
}

/**
 * Run `build` at most once per key across concurrent callers.
 *
 * A follower whose leader REJECTS does not inherit the failure: it falls
 * through and builds on its own. That matters because each caller passes a
 * builder closed over its OWN pooled client (AA-122's other half) — if the
 * leader's request is aborted and its client released mid-build, the shared
 * promise rejects for a reason that has nothing to do with the follower. A
 * leader's own failure still propagates to its own caller, which is correct:
 * that request really did fail.
 */
export async function buildInsightsSectionOnce<T>(
  cacheKey: string,
  build: () => Promise<T>,
): Promise<T> {
  const inflight = INFLIGHT.get(cacheKey) as Promise<T> | undefined;
  if (inflight) {
    try {
      return await inflight;
    } catch {
      // Leader failed; become a leader ourselves rather than failing with it.
    }
  }

  const started = build();
  INFLIGHT.set(cacheKey, started);
  try {
    return await started;
  } finally {
    // Only clear our own entry — a later leader may already have replaced it.
    if (INFLIGHT.get(cacheKey) === started) {
      INFLIGHT.delete(cacheKey);
    }
  }
}
