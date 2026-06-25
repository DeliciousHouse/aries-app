'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createAriesV1Api, type ScheduledPostsResponse } from '@/lib/api/aries-v1';
import { useRuntimePosts } from '@/hooks/use-runtime-social-content';
import { useTenantTimezone } from '@/hooks/use-tenant-timezone';
import CalendarPresenter from '@/frontend/aries-v1/presenters/calendar-presenter';
import {
  createCalendarViewModel,
  type UnscheduledPost,
} from '@/frontend/aries-v1/view-models/calendar';
import { useCalendarScheduling } from '@/frontend/aries-v1/hooks/useCalendarScheduling';
import type { AllowedTargetPlatform } from '@/backend/social-content/scheduled-posts';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { LoadingStateGrid } from './components';

// The calendar window: a generous range so most queued posts are visible
// without paging. The grid itself navigates within whatever it receives.
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 2);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setMonth(to.getMonth() + 4);
  to.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export interface AriesCalendarScreenProps {
  /**
   * Server-computed list of platforms the operator can schedule to right now.
   * Omit (or leave undefined) to get the default facebook+instagram picker —
   * byte-identical to the old behaviour when all rollout flags are OFF.
   */
  allowedPublishPlatforms?: AllowedTargetPlatform[];
}

export default function AriesCalendarScreen({ allowedPublishPlatforms }: AriesCalendarScreenProps = {}) {
  const api = useMemo(() => createAriesV1Api({}), []);
  const range = useMemo(() => defaultRange(), []);

  const campaigns = useRuntimePosts({ autoLoad: true });

  const [schedule, setSchedule] = useState<ScheduledPostsResponse | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);

  const loadSchedule = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const response = await api.getScheduledPosts(range);
      setSchedule(response);
      setScheduleError(null);
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : 'Failed to load the calendar queue.');
    } finally {
      setScheduleLoading(false);
    }
  }, [api, range]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  const timeZone = useTenantTimezone();

  const scheduling = useCalendarScheduling({ timeZone });

  const handleSchedule = useCallback(
    async (
      item:
        | { kind: 'event'; event: { id: string; postId: string; jobId: string | null; targetPlatforms: string[]; dayKey: string } }
        | { kind: 'unscheduled'; post: UnscheduledPost },
      targetDayKey: string,
    ) => {
      const platformsFor = (targets: string[]): string[] =>
        targets.length > 0 ? targets : ['facebook'];

      if (item.kind === 'event') {
        await scheduling.scheduleEvent(
          {
            eventId: item.event.id,
            jobId: item.event.jobId,
            postId: item.event.postId,
            platforms: platformsFor(item.event.targetPlatforms),
            fromDayKey: item.event.dayKey,
          },
          { dayKey: targetDayKey },
        );
      } else {
        await scheduling.scheduleEvent(
          {
            eventId: `unscheduled:${item.post.postId}`,
            jobId: item.post.jobId,
            postId: item.post.postId,
            platforms: platformsFor(item.post.platform ? [item.post.platform] : []),
            fromDayKey: null,
          },
          { dayKey: targetDayKey },
        );
      }
      // Refetch the authoritative queue, then drop the optimistic overlay.
      await loadSchedule();
      scheduling.resetPendingMoves();
    },
    [loadSchedule, scheduling],
  );

  if (scheduleLoading) {
    return <LoadingStateGrid />;
  }

  if (scheduleError && !schedule) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(scheduleError, 'The calendar is not available right now.')}
      </div>
    );
  }

  if (campaigns.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(campaigns.error.message, 'The calendar is not available right now.')}
      </div>
    );
  }

  const model = createCalendarViewModel({
    scheduledPosts: schedule?.posts ?? [],
    posts: campaigns.data?.posts ?? [],
    unscheduledPosts: (schedule?.unscheduled ?? []).map((post) => ({
      postId: post.postId,
      jobId: post.jobId,
      title: post.title,
      caption: post.caption,
      platform: post.platform,
      imageUrl: post.imageUrl ?? null,
      href: post.jobId ? `/dashboard/social-content/${post.jobId}` : '/dashboard/calendar',
    })),
    timeZone,
  });

  // Optimistic day-key overrides: map pendingMoves -> {eventId: toDayKey}.
  const pendingDayKeys = Object.fromEntries(
    Object.values(scheduling.pendingMoves).map((move) => [move.eventId, move.toDayKey]),
  );

  return (
    <CalendarPresenter
      model={model}
      onSchedule={handleSchedule}
      pendingDayKeys={pendingDayKeys}
      schedulingError={scheduling.error}
      campaignsLoading={campaigns.isLoading}
      onRescheduled={() => {
        void loadSchedule();
      }}
      allowedPublishPlatforms={allowedPublishPlatforms}
    />
  );
}
