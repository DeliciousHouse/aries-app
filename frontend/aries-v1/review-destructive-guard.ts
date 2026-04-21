// Pure policy helper shared between the review-item UI and the unit tests
// in tests/review-flow-destructive-guards.test.ts. Keeping this in its own
// plain-TS module (no 'use client', no React imports) so Node tests can
// import it directly without pulling in the whole React tree.
//
// Contract: destructive review actions (changes_requested / reject) MUST be
// accompanied by a non-empty comment. Approve does NOT require a comment.

export type ReviewDecisionAction = 'approve' | 'changes_requested' | 'reject';

export function isDestructiveActionBlocked(
  action: ReviewDecisionAction,
  note: string | null | undefined,
): boolean {
  if (action !== 'changes_requested' && action !== 'reject') return false;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return trimmed.length === 0;
}
