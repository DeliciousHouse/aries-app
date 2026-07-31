/**
 * backend/insights/attribution-scope.ts
 *
 * S4-1 / AA-104 (Gap C2b) — decides whether the Activity and Top sections read
 * the tenant's *Aries-published* posts or *all channel* posts for a window.
 *
 * Background. #785 removed an `aries_post_id IS NOT NULL` filter from those two
 * sections because nothing wrote the column, so every tenant saw empty sections.
 * S3-3 added the production writer plus a backfill, so the filter is meaningful
 * again — but only for tenants whose history is actually stamped. Re-adding it
 * unconditionally would reproduce the #785 regression for everyone else.
 *
 * The rule, encoded:
 *
 *   scope = 'aries'        when the window's attribution coverage clears the
 *                          threshold AND at least one post is attributed
 *   scope = 'all-channel'  otherwise (the #785 behavior, byte-identical)
 *
 * The `attributedPosts > 0` half is what makes "sections never re-empty"
 * provable rather than probable: `computeAttributionCoverage` reports an
 * all-unattributed window as trustworthy when the threshold is 0, and scoping
 * to `aries` there would empty the section. Above a positive threshold the
 * attributed set is at least `threshold x totalPosts` of a non-empty set, so
 * the scoped section is non-empty by construction.
 *
 * Every failure path falls back to 'all-channel': an attribution outage must
 * degrade to the section everyone already sees, never to an empty one.
 */

import {
  computeAttributionCoverage,
  type AttributionCoverageResult,
} from './attribution-coverage';
import { isAttributionScopeEnabled } from './attribution-scope-env';

export type AttributionQueryable = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

/** 'aries' reads only posts stamped with `aries_post_id`; 'all-channel' reads every post. */
export type AttributionScope = 'aries' | 'all-channel';

export interface AttributionScopeResult {
  scope: AttributionScope;
  /** True when the caller's queries must add the `aries_post_id IS NOT NULL` predicate. */
  attributedOnly: boolean;
  totalPosts: number;
  attributedPosts: number;
  /** Fraction from 0 to 1, rounded to 4dp for the payload. */
  coverage: number;
  threshold: number;
}

/**
 * Share of a window's posts that must carry `aries_post_id` before the
 * attribution-scoped view is trusted. 0.8 keeps a small tail of unstamped
 * history (a manual post, a pre-backfill row) from flipping the section back
 * to all-channel, while a genuinely unstamped tenant stays well below it.
 */
export const DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD = 0.8;

/**
 * Reads `ARIES_INSIGHTS_ATTRIBUTION_THRESHOLD`. Anything that is not a finite
 * number in the inclusive 0–1 range falls back to the default with a warning —
 * a typo'd threshold must not silently scope the sections to an empty set.
 */
export function resolveAttributionCoverageThreshold(
  raw: string | undefined = process.env.ARIES_INSIGHTS_ATTRIBUTION_THRESHOLD,
): number {
  if (raw == null || raw.trim() === '') return DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD;

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[insights-attribution] ignoring ARIES_INSIGHTS_ATTRIBUTION_THRESHOLD=${raw}; ` +
        `expected a number between 0 and 1. Using ${DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD}.`,
    );
    return DEFAULT_ATTRIBUTION_COVERAGE_THRESHOLD;
  }
  return parsed;
}

/**
 * The all-channel fallback, used verbatim on every uncertain path so the
 * degraded shape is identical no matter which step failed.
 */
function allChannel(
  totalPosts: number,
  attributedPosts: number,
  threshold: number,
): AttributionScopeResult {
  return {
    scope: 'all-channel',
    attributedOnly: false,
    totalPosts,
    attributedPosts,
    coverage: totalPosts === 0 ? 0 : round4(attributedPosts / totalPosts),
    threshold,
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Decide the scope for one tenant/period/platform window.
 *
 * Runs a single COUNT query on the same predicate the section builders use, so
 * the coverage it measures is the coverage of the exact rows being read. The
 * caller passes the resolved window start and platform filter it already
 * computed — this never re-derives the window (guardrail #1: one extra
 * sequential query, no fan-out).
 */
export async function resolveAttributionScope(args: {
  db: AttributionQueryable;
  tenantId: number;
  fromDate: Date | string;
  platformFilter: string | null;
  threshold?: number;
  enabled?: boolean;
}): Promise<AttributionScopeResult> {
  const threshold = args.threshold ?? resolveAttributionCoverageThreshold();

  // Flag off (the shipped default): no coverage query, no scope, no cost —
  // the calling section's numbers are exactly what they are today. See
  // attribution-scope-env.ts for why this is gated rather than always on.
  if (!(args.enabled ?? isAttributionScopeEnabled())) {
    return allChannel(0, 0, threshold);
  }

  let totalPosts = 0;
  let attributedPosts = 0;

  try {
    const res = await args.db.query<{ total_posts: string; attributed_posts: string }>(
      `SELECT
         COUNT(*)                                            AS total_posts,
         COUNT(*) FILTER (WHERE aries_post_id IS NOT NULL)   AS attributed_posts
       FROM insights_posts
       WHERE tenant_id     = $1
         AND published_at  >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [args.tenantId, args.fromDate, args.platformFilter],
    );

    totalPosts = Number(res.rows[0]?.total_posts ?? 0);
    attributedPosts = Number(res.rows[0]?.attributed_posts ?? 0);
  } catch (err) {
    console.warn(
      '[insights-attribution] coverage query failed; falling back to all-channel scope:',
      err instanceof Error ? err.message : err,
    );
    return allChannel(0, 0, threshold);
  }

  if (!Number.isInteger(totalPosts) || !Number.isInteger(attributedPosts)) {
    return allChannel(0, 0, threshold);
  }

  let coverage: AttributionCoverageResult;
  try {
    coverage = computeAttributionCoverage({ totalPosts, attributedPosts }, threshold);
  } catch (err) {
    console.warn(
      '[insights-attribution] coverage math rejected the counts; falling back to all-channel scope:',
      err instanceof Error ? err.message : err,
    );
    return allChannel(totalPosts, attributedPosts, threshold);
  }

  // `attributedPosts > 0` is the never-re-empty guard, not a redundancy check:
  // a zero threshold makes an all-unattributed window "trustworthy".
  if (!coverage.isTrustworthy || attributedPosts === 0) {
    return allChannel(totalPosts, attributedPosts, threshold);
  }

  return {
    scope: 'aries',
    attributedOnly: true,
    totalPosts,
    attributedPosts,
    coverage: round4(coverage.coverage),
    threshold,
  };
}
