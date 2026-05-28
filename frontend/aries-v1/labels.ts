/**
 * Centralized label mappings for runtime status enums that show up in user-facing
 * copy across the dashboard. Each helper is the single source of truth for how a
 * raw enum value renders. New enum values land here first so screens stay in sync
 * and no caller needs to invent its own `.replace('_', ' ')` fallback.
 *
 * Rule: every helper has an exhaustive switch on known values and a fallback
 * branch that title-cases the raw string. The fallback exists to avoid rendering
 * `undefined` or `[object Object]` if the backend ever emits a value before the
 * frontend type catches up — pin every new value with a test in
 * `tests/aries-v1-labels.test.ts`.
 */
import type { AriesPostStatus, AriesItemStatus } from '@/lib/api/aries-v1';

/**
 * Render the per-platform dispatch status emitted by the scheduled-posts worker
 * for the Calendar event card and modal. Source of values:
 * scripts/automations/scheduled-posts-worker.mjs (`dispatch_status` column).
 */
export function formatDispatchStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'in_flight':
      return 'In flight';
    case 'dispatched':
      return 'Dispatched';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return titleCaseRawStatus(status);
  }
}

/**
 * Render the short tag shown at the top-right of a Calendar event card. Kept
 * deliberately short (3-4 chars) to fit the tight chip — verbose values land in
 * the modal via `formatDispatchStatusLabel`.
 */
export function formatDispatchStatusChip(status: string): string {
  switch (status) {
    case 'dispatched':
      return 'Sent';
    case 'failed':
      return 'Fail';
    case 'in_flight':
      return 'Live';
    case 'pending':
      return 'Sch';
    case 'skipped':
      return 'Skip';
    default:
      // Unknown future status: keep 'Sch' as the neutral fallback so callers do
      // not see the success label ('Sent') by accident.
      return 'Sch';
  }
}

const CAMPAIGN_STATUS_LABELS: Record<AriesPostStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  live: 'Live',
  changes_requested: 'Needs changes',
  rejected: 'Rejected',
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  ready_to_publish: 'Ready to publish',
  published_to_meta: 'Published to Meta',
  published_to_meta_paused: 'Published to Meta (Paused)',
};

/**
 * Render an AriesPostStatus or AriesItemStatus in the same casing the
 * StatusChip uses, without the `.replace('_', ' ')` lowercase trap.
 *
 * Returns a properly cased label for every known value and falls back to
 * title-casing the raw enum string for any future value. The bug class this
 * replaces (calendar-presenter.tsx:344 + :394) rendered values like
 * "published to meta (paused)" instead of "Published to Meta (Paused)".
 */
export function formatPostStatusLabel(status: string): string {
  // Use Object.hasOwn (not `in`) so inherited Object.prototype keys like
  // 'toString', '__proto__', or 'constructor' can't accidentally route through
  // the label-map and return a non-string. A raw `in` check would resolve those
  // names against the prototype chain and index into the map, returning
  // undefined or a method reference.
  if (Object.hasOwn(CAMPAIGN_STATUS_LABELS, status)) {
    return CAMPAIGN_STATUS_LABELS[status as AriesPostStatus];
  }
  if (Object.hasOwn(ITEM_STATUS_LABELS, status)) {
    return ITEM_STATUS_LABELS[status];
  }
  return titleCaseRawStatus(status);
}

/**
 * Title-case a raw snake_case status by capitalizing each word and replacing
 * underscores with spaces. Used as the last-resort fallback so an unknown enum
 * value never renders as raw `published_to_meta_paused`.
 */
function titleCaseRawStatus(status: string): string {
  if (!status) return '';
  return status
    .split('_')
    .map((segment) => (segment ? segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase() : segment))
    .join(' ');
}

// Re-export item-status type alias to avoid importing it from two places.
export type { AriesItemStatus };
