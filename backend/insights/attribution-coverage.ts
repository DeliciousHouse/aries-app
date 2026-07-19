/**
 * Pure attribution-coverage math for insights period windows (S3-7 / AA-103).
 *
 * Callers should obtain the two counts from the same tenant/platform/time-window
 * query. The result lets attribution-scoped readers fall back to all-channel
 * metrics when too much history is missing `aries_post_id`.
 */

export interface AttributionCoverageCounts {
  totalPosts: number;
  attributedPosts: number;
}

export interface AttributionCoverageResult extends AttributionCoverageCounts {
  /** Fraction from 0 to 1; zero when the window has no posts. */
  coverage: number;
  threshold: number;
  /** Empty windows are never trustworthy, including when threshold is zero. */
  isTrustworthy: boolean;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

export function computeAttributionCoverage(
  { totalPosts, attributedPosts }: AttributionCoverageCounts,
  threshold: number,
): AttributionCoverageResult {
  assertNonNegativeInteger(totalPosts, 'totalPosts');
  assertNonNegativeInteger(attributedPosts, 'attributedPosts');

  if (attributedPosts > totalPosts) {
    throw new RangeError('attributedPosts cannot exceed totalPosts');
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be a finite number between 0 and 1');
  }

  const coverage = totalPosts === 0 ? 0 : attributedPosts / totalPosts;

  return {
    totalPosts,
    attributedPosts,
    coverage,
    threshold,
    isTrustworthy: totalPosts > 0 && coverage >= threshold,
  };
}
