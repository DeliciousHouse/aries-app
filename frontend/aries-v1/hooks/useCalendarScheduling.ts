'use client';

import { useCallback, useState } from 'react';

import type { CalendarEvent } from '@/frontend/aries-v1/view-models/calendar';
import { wallTimeToUtc } from '@/lib/format-timestamp';

/**
 * C2 — drag-to-reschedule logic, extracted from the render component.
 * `CalendarPresenter` stays a pure render component; this hook owns the
 * optimistic move, fires `PATCH .../schedule`, and reverts local state on
 * error. Scheduling a NOT-yet-scheduled post (the backlog tray, T13) goes
 * through the same PATCH — the route's P1.1 approval gate applies either way.
 */

export interface ScheduleTarget {
  /** YYYY-MM-DD calendar cell, in the tenant timezone. */
  dayKey: string;
  /** HH:mm wall time in the tenant zone; defaults to the existing post time. */
  wallTime?: string;
}

export interface CalendarSchedulingDeps {
  /** Tenant business timezone — the dropped wall time is interpreted in it. */
  timeZone: string;
  /** Base URL for the API (tests inject a stub; '' in the app). */
  baseUrl?: string;
  /** Injectable fetch for unit tests. */
  fetchImpl?: typeof fetch;
}

export interface OptimisticMove {
  eventId: string;
  fromDayKey: string;
  toDayKey: string;
}

export type SchedulingStatus = 'idle' | 'saving' | 'error';

// 09:00 tenant-local is a sensible publish time when an operator drops a post
// on a bare calendar cell without picking an hour.
const DEFAULT_DROP_WALL_HOUR = '09:00';

function buildWallTime(dayKey: string, wallTime: string | undefined): string {
  return `${dayKey}T${wallTime ?? DEFAULT_DROP_WALL_HOUR}`;
}

function patchUrl(baseUrl: string, jobId: string, postId: string): string {
  return (
    `${baseUrl}/api/social-content/jobs/${encodeURIComponent(jobId)}` +
    `/posts/${encodeURIComponent(postId)}/schedule`
  );
}

export function useCalendarScheduling(deps: CalendarSchedulingDeps) {
  const { timeZone, baseUrl = '', fetchImpl } = deps;
  const doFetch = fetchImpl ?? fetch;

  const [status, setStatus] = useState<SchedulingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // Pending optimistic moves keyed by eventId. The presenter overlays these
  // on the server data so the tile jumps immediately; a failure clears it.
  const [pendingMoves, setPendingMoves] = useState<Record<string, OptimisticMove>>({});

  const clearError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  /**
   * Reschedule an existing calendar event (drag a tile to a new cell), or
   * schedule a tray post for the first time. Both call the same PATCH.
   * Returns true on success, false on failure (caller may re-render).
   */
  const scheduleEvent = useCallback(
    async (
      input: {
        eventId: string;
        jobId: string | null;
        postId: string;
        platforms: string[];
        fromDayKey: string | null;
      },
      target: ScheduleTarget,
    ): Promise<boolean> => {
      if (!input.jobId) {
        setStatus('error');
        setError('This post has no campaign job and cannot be scheduled from the calendar.');
        return false;
      }
      if (input.platforms.length === 0) {
        setStatus('error');
        setError('Pick at least one platform before scheduling this post.');
        return false;
      }
      const wall = buildWallTime(target.dayKey, target.wallTime);
      const utc = wallTimeToUtc(wall, timeZone);
      if (!utc) {
        setStatus('error');
        setError('Could not resolve the drop target to a valid publish time.');
        return false;
      }

      // Optimistic move: record it so the presenter can render the tile on the
      // target cell immediately.
      const move: OptimisticMove = {
        eventId: input.eventId,
        fromDayKey: input.fromDayKey ?? target.dayKey,
        toDayKey: target.dayKey,
      };
      setPendingMoves((current) => ({ ...current, [input.eventId]: move }));
      setStatus('saving');
      setError(null);

      try {
        const response = await doFetch(patchUrl(baseUrl, input.jobId, input.postId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scheduled_at: utc.toISOString(),
            platforms: input.platforms,
          }),
        });
        if (!response.ok) {
          // Revert the optimistic move; surface the route's reason if present.
          let reason = `Failed to schedule the post (HTTP ${response.status}).`;
          try {
            const body = (await response.json()) as { error?: string; reason?: string };
            reason = body.error || body.reason || reason;
          } catch {
            // Non-JSON error body — keep the generic message.
          }
          setPendingMoves((current) => {
            const next = { ...current };
            delete next[input.eventId];
            return next;
          });
          setStatus('error');
          setError(reason);
          return false;
        }
        // Success: keep the optimistic move until the caller refetches the
        // queue; the refetch replaces the move with authoritative data.
        setStatus('idle');
        return true;
      } catch (cause) {
        setPendingMoves((current) => {
          const next = { ...current };
          delete next[input.eventId];
          return next;
        });
        setStatus('error');
        setError(cause instanceof Error ? cause.message : 'Network error while scheduling.');
        return false;
      }
    },
    [baseUrl, doFetch, timeZone],
  );

  /** Drops all optimistic moves — call after a fresh queue fetch lands. */
  const resetPendingMoves = useCallback(() => {
    setPendingMoves({});
  }, []);

  return {
    status,
    error,
    pendingMoves,
    scheduleEvent,
    clearError,
    resetPendingMoves,
  };
}
