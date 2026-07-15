/**
 * backend/insights/hours-saved.ts
 *
 * S3-1 / AA-97 — single source of truth for the "hours saved" ESTIMATE shown in
 * the Hero band and the Activity strip. Two builders previously computed it two
 * different ways (0.35–0.9h/post + 0.05h/comment  vs  a flat 3h/post), so the
 * same dashboard could show two disagreeing numbers.
 *
 * This is a SYNTHETIC ESTIMATE, not a measurement — always rendered with a "~"
 * prefix and honest "estimate" framing. HOURS_PER_POST is an assumption (research
 * + writing + creative + scheduling for one post) worth sanity-checking against
 * real operator time; it is kept as one tunable constant rather than a per-surface
 * guess so the two surfaces can never diverge again.
 *
 * Reconciled to posts-only: the previous per-comment credit (0.05h) is dropped —
 * comment-handling time is more speculative than per-post time, so a smaller
 * synthetic surface is the more honest estimate.
 */
export const HOURS_PER_POST = 3;

export function estimateHoursSaved(posts: number): number {
  return Math.round(posts * HOURS_PER_POST * 10) / 10;
}
