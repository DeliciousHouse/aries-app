import type { RuntimePostListItem, ScheduledPostItem } from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';
import {
  DEFAULT_TENANT_TIMEZONE,
  formatInTenantZone,
  tenantZoneAbbreviation,
  tenantZoneDateKey,
} from '@/lib/format-timestamp';
import { failedJobLabel, isFailedExecutionState } from '@/frontend/aries-v1/view-models/execution-state';

/**
 * A1 / T11 — the calendar grid is fed by `scheduled_posts` (real queued
 * posts with a real dispatch_status), not the runtime `dashboard.calendarEvents`.
 * The post strip ("Social content status at a glance") still comes from
 * `useRuntimePosts`. Day keys are computed in the tenant business
 * timezone (C1) so a post scheduled for 11pm tenant-time lands on the right
 * cell for an operator in any browser zone.
 */

export type CalendarEventStatus =
  | RuntimePostListItem['status']
  | RuntimePostListItem['dashboardStatus'];

export interface CalendarEvent {
  id: string;
  postId: string;
  jobId: string | null;
  title: string;
  platform: string;
  targetPlatforms: string[];
  scheduledFor: string;
  /** UTC instant ISO — the authoritative time; the grid converts it per zone. */
  scheduledForIso: string;
  status: CalendarEventStatus;
  dispatchStatus: string;
  href: string;
  timestamp: number;
  /** YYYY-MM-DD key computed in the tenant timezone. */
  dayKey: string;
  dispatches: ScheduledPostItem['dispatches'];
}

export interface UnscheduledPost {
  postId: string;
  jobId: string | null;
  title: string;
  caption: string;
  platform: string | null;
  imageUrl: string | null;
  href: string;
}

export interface CalendarViewModel {
  timeZone: string;
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  events: CalendarEvent[];
  unscheduled: UnscheduledPost[];
  posts: Array<{
    id: string;
    name: string;
    status: RuntimePostListItem['status'];
    nextScheduled: string;
    stageLabel: string;
    pendingApprovals: string;
    href: string;
    failed: boolean;
    failureLabel: string | null;
    actionLabel: string | null;
  }>;
}

// Maps a scheduled_posts dispatch_status onto the calendar status palette the
// presenter already styles (`statusPill`).
function dispatchStatusToEventStatus(dispatchStatus: string): CalendarEventStatus {
  switch (dispatchStatus) {
    case 'dispatched':
      return 'live';
    case 'failed':
      return 'changes_requested';
    case 'in_flight':
      return 'scheduled';
    default:
      return 'scheduled';
  }
}

function scheduledPostLabel(value: string, timeZone: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    return 'Scheduled';
  }
  return `${formatInTenantZone(value, timeZone)} ${tenantZoneAbbreviation(value, timeZone)}`;
}

export interface CalendarViewModelInput {
  scheduledPosts: ScheduledPostItem[];
  posts: RuntimePostListItem[];
  /** Approved posts that have no scheduled_posts row — the backlog tray. */
  unscheduledPosts?: UnscheduledPost[];
  timeZone?: string;
}

export function createCalendarViewModel(input: CalendarViewModelInput): CalendarViewModel {
  const timeZone = input.timeZone || DEFAULT_TENANT_TIMEZONE;

  const events: CalendarEvent[] = input.scheduledPosts
    .map((post) => {
      const timestamp = Date.parse(post.scheduledFor);
      if (!Number.isFinite(timestamp)) {
        return null;
      }
      const dayKey = tenantZoneDateKey(post.scheduledFor, timeZone);
      if (!dayKey) {
        return null;
      }
      return {
        id: post.id,
        postId: post.postId,
        jobId: post.jobId,
        title: post.title,
        platform: post.platform || post.targetPlatforms[0] || 'meta',
        targetPlatforms: post.targetPlatforms,
        scheduledFor: scheduledPostLabel(post.scheduledFor, timeZone),
        scheduledForIso: post.scheduledFor,
        status: dispatchStatusToEventStatus(post.dispatchStatus),
        dispatchStatus: post.dispatchStatus,
        href: post.jobId ? `/dashboard/social-content/${post.jobId}` : '/dashboard/calendar',
        timestamp,
        dayKey,
        dispatches: post.dispatches,
      } satisfies CalendarEvent;
    })
    .filter((event): event is CalendarEvent => event !== null)
    .sort((left, right) => left.timestamp - right.timestamp);

  const unscheduled = input.unscheduledPosts ?? [];

  const failedCount = events.filter((event) => event.dispatchStatus === 'failed').length;
  const dispatchedCount = events.filter((event) => event.dispatchStatus === 'dispatched').length;

  return {
    timeZone,
    hero: {
      eyebrow: 'Calendar',
      title: 'What is going out and when',
      description:
        'The publish queue, on a week/month grid. Every tile is a real queued post — ' +
        'drag to reschedule, or drag an approved post in from the backlog. ' +
        'The calendar shows only queued posts, so it starts empty until you schedule something.',
      metrics: [
        {
          label: 'Queued posts',
          value: String(events.length),
          detail:
            events.length > 0
              ? 'Every tile is a real row in the publish queue.'
              : 'Nothing is queued yet. Drag an approved post onto a date to schedule it.',
        },
        {
          label: 'Awaiting backlog',
          value: String(unscheduled.length),
          detail:
            unscheduled.length > 0
              ? 'Approved posts with no publish date yet — drag them onto the grid.'
              : 'No approved posts are waiting to be scheduled.',
          tone: unscheduled.length > 0 ? 'watch' : 'good',
        },
        {
          label: 'Published',
          value: String(dispatchedCount),
          detail:
            dispatchedCount > 0
              ? 'These posts have been confirmed sent to their platforms.'
              : 'No queued posts have published yet.',
          tone: dispatchedCount > 0 ? 'good' : 'default',
        },
        {
          label: 'Failed dispatch',
          value: String(failedCount),
          detail:
            failedCount > 0
              ? 'These posts failed to publish — review the per-platform error.'
              : 'No queued posts have failed dispatch.',
          tone: failedCount > 0 ? 'watch' : 'good',
        },
      ],
    },
    events,
    unscheduled,
    posts: input.posts.map((campaign) => {
      const failed = isFailedExecutionState(campaign.executionState);
      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        nextScheduled: campaign.nextScheduled,
        stageLabel: campaign.stageLabel,
        pendingApprovals: String(campaign.pendingApprovals),
        href: `/dashboard/social-content/${campaign.id}`,
        failed,
        failureLabel: failed ? failedJobLabel(campaign.stageLabel) : null,
        actionLabel: failed ? 'View failure details' : null,
      };
    }),
  };
}
