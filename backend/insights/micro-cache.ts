/**
 * backend/insights/micro-cache.ts
 *
 * S7-3 / AA-121 (gap D3) — a short-TTL in-process cache for the insights
 * endpoints that have no cache at all.
 *
 * WHY NOT THE EXISTING CACHE. The six narrative-style sections persist their
 * bodies to `insights_narratives` with a 1h TTL and a TEMPLATE_VERSION. That is
 * the right shape for an expensive, slowly-changing body and the wrong shape
 * here: these endpoints change by the minute, and a DB round-trip plus a row
 * write to save a 90ms query is not a saving. This is a 60-second micro-cache —
 * memory only, no row, no version.
 *
 * WHAT IT ACTUALLY BUYS. /dashboard/analytics fires three of these aggregates
 * concurrently from the browser on every load, and /insights fires three more.
 * Under the 50-user profile that is the pool pressure the scale smoke exists to
 * find. A hit costs no pooled client at all — which is why every caller must
 * check the cache BEFORE `pool.connect()`, exactly as the force throttle does.
 * A cache consulted after the client is acquired concedes the resource it exists
 * to protect.
 *
 * TENANT SCOPING IS THE WHOLE SAFETY STORY. Every key is built by
 * `insightsMicroCacheKey`, which puts the tenant id first and refuses a
 * missing/non-numeric one. A key that omitted the tenant would serve one
 * tenant's comments to another — the worst failure this codebase can have, and
 * one no SQL predicate can catch because on a hit the query never runs.
 *
 * PER-PROCESS, deliberately, matching `cache-policy.ts`'s in-flight map and the
 * force throttle's bucket. With ARIES_WEB_CONCURRENCY workers the real hit rate
 * is lower than a shared cache would give; a cross-process cache would mean a
 * network round-trip on the very path we are trying to make cheaper.
 */

/**
 * Hard ceiling on freshness. The card caps this at 60s and the cap is enforced
 * here rather than trusted to call sites: conversations carries reply/unread
 * state, and a caller that quietly passed 10 minutes would make a just-sent
 * reply look unsent for ten minutes.
 */
export const INSIGHTS_MICRO_CACHE_MAX_TTL_MS = 60_000;
export const INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS = 60_000;

/**
 * Bound on retained entries. An unbounded map keyed by (tenant × section ×
 * period × platform × …) is a slow leak on a long-lived worker. On overflow the
 * OLDEST-INSERTED entry is dropped; entries live 60s at most, so this only ever
 * bites under a burst of distinct keys, where dropping the oldest is right.
 */
export const INSIGHTS_MICRO_CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  value: unknown;
  expiresAtMs: number;
}

const STORE = new Map<string, CacheEntry>();

/** Test seam — the store is process-global. */
export function __resetInsightsMicroCacheForTests(): void {
  STORE.clear();
}

/** Test seam — current retained entry count. */
export function __insightsMicroCacheSizeForTests(): number {
  return STORE.size;
}

export function clampMicroCacheTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS;
  }
  return Math.min(Math.floor(ttlMs as number), INSIGHTS_MICRO_CACHE_MAX_TTL_MS);
}

/**
 * Build a cache key. The tenant id leads and is REQUIRED — a null return means
 * "do not cache", which every caller must treat as a straight passthrough
 * rather than as an empty key.
 *
 * `parts` are the request inputs that change the body (period, platform, limit,
 * offset, days, sort). Anything that changes the payload and is not listed here
 * would serve the wrong body to the same tenant.
 */
export function insightsMicroCacheKey(
  section: string,
  tenantId: number | string | null | undefined,
  parts: Record<string, string | number | null | undefined> = {},
): string | null {
  const numericTenant = Number(tenantId);
  if (!Number.isSafeInteger(numericTenant) || numericTenant < 1) return null;
  if (!section.trim()) return null;

  const suffix = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k] ?? ''}`)
    .join('&');
  return `t:${numericTenant}|s:${section}|${suffix}`;
}

/** Read a live entry, or null when absent/expired. Expired entries are evicted. */
export function readInsightsMicroCache<T>(key: string | null, nowMs = Date.now()): T | null {
  if (!key) return null;
  const entry = STORE.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    STORE.delete(key);
    return null;
  }
  return entry.value as T;
}

export function writeInsightsMicroCache(
  key: string | null,
  value: unknown,
  ttlMs: number = INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS,
  nowMs = Date.now(),
): void {
  if (!key) return;
  if (STORE.size >= INSIGHTS_MICRO_CACHE_MAX_ENTRIES && !STORE.has(key)) {
    // Map preserves insertion order, so the first key is the oldest insert.
    const oldest = STORE.keys().next();
    if (!oldest.done) STORE.delete(oldest.value);
  }
  STORE.set(key, { value, expiresAtMs: nowMs + clampMicroCacheTtlMs(ttlMs) });
}

/**
 * Drop every entry for a tenant, optionally limited to one section.
 *
 * This is what keeps the conversations cache honest: replying to a comment
 * changes `is_replied`, and without invalidation the operator would watch their
 * own reply not appear for up to a minute. Invalidating on the write is strictly
 * better than dropping the field from the payload, which would leave the list
 * unable to show reply state at all.
 */
export function invalidateInsightsMicroCache(
  tenantId: number | string | null | undefined,
  section?: string,
): number {
  const numericTenant = Number(tenantId);
  if (!Number.isSafeInteger(numericTenant) || numericTenant < 1) return 0;
  const tenantPrefix = `t:${numericTenant}|`;
  const sectionPrefix = section ? `${tenantPrefix}s:${section}|` : null;

  let removed = 0;
  for (const key of [...STORE.keys()]) {
    const match = sectionPrefix ? key.startsWith(sectionPrefix) : key.startsWith(tenantPrefix);
    if (match) {
      STORE.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * `Cache-Control` for a micro-cached response.
 *
 * `private` is not optional. These bodies are per-tenant, and a shared cache
 * (a CDN, a corporate proxy) holding one under a URL that carries no tenant in
 * its path would hand it to the next tenant who asked. `must-revalidate` keeps a
 * browser from extending the window on its own.
 */
export function microCacheControlHeader(ttlMs: number): string {
  const seconds = Math.max(1, Math.floor(clampMicroCacheTtlMs(ttlMs) / 1000));
  return `private, max-age=${seconds}, must-revalidate`;
}
