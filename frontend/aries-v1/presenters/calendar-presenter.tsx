'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Globe,
  Inbox,
  Layers3,
  LoaderCircle,
  Music2,
  Trash2,
  X as CloseIcon,
} from 'lucide-react';
import { FacebookIcon, InstagramIcon, LinkedinIcon, YoutubeIcon } from '../brand-icons';

import type {
  CalendarEvent,
  CalendarViewModel,
  UnscheduledPost,
} from '@/frontend/aries-v1/view-models/calendar';
import { RedditIcon, XIcon } from '@/frontend/components/Icons';
import RescheduleDrawer from '@/frontend/aries-v1/reschedule-drawer';
import { ALLOWED_TARGET_PLATFORMS, type AllowedTargetPlatform } from '@/backend/social-content/scheduled-posts';
import {
  formatTimeInTenantZone,
  tenantZoneDateKey,
  tenantZoneParts,
} from '@/lib/format-timestamp';
import {
  formatPostStatusLabel,
  formatDispatchStatusChip,
  formatDispatchStatusLabel,
} from '@/frontend/aries-v1/labels';

type CalendarMode = 'week' | 'month';

// The payload @dnd-kit carries on a draggable (a calendar tile or a tray item).
export type DragItemData =
  | { kind: 'event'; event: CalendarEvent }
  | { kind: 'unscheduled'; post: UnscheduledPost };

export type ResolvedDrag = { item: DragItemData; targetDayKey: string };

/**
 * Pure drag-end decision: given the dragged item's data and the day key of the
 * cell it landed on, decide whether (and what) to schedule. Extracted so the
 * component test can simulate a @dnd-kit drag deterministically without
 * driving flaky jsdom pointer events. Returns null for a no-op (a tile
 * dropped back on its own cell, or missing data).
 */
export function resolveDragSchedule(
  data: DragItemData | undefined | null,
  targetDayKey: string,
): ResolvedDrag | null {
  if (!data || !targetDayKey) {
    return null;
  }
  if (data.kind === 'event') {
    if (data.event.dayKey === targetDayKey) {
      return null;
    }
    return { item: { kind: 'event', event: data.event }, targetDayKey };
  }
  return { item: { kind: 'unscheduled', post: data.post }, targetDayKey };
}

export interface CalendarPresenterProps {
  model: CalendarViewModel;
  /**
   * Drag drop handler — receives the dragged item and the YYYY-MM-DD tenant-zone
   * cell it landed on. The calendar screen wires this to useCalendarScheduling.
   */
  onSchedule?: (
    item:
      | { kind: 'event'; event: CalendarEvent }
      | { kind: 'unscheduled'; post: UnscheduledPost },
    targetDayKey: string,
  ) => void;
  /** Optimistic day-key overrides keyed by event id (pendingMoves from the hook). */
  pendingDayKeys?: Record<string, string>;
  schedulingError?: string | null;
  /** When true, the Campaign status strip renders a loading skeleton instead of empty-state. */
  campaignsLoading?: boolean;
  /** Called after the RescheduleDrawer saves — lets the screen refetch the queue. */
  onRescheduled?: () => void;
  /**
   * Platforms the operator is allowed to schedule to right now. Computed
   * server-side from rollout flags and passed down. Defaults to
   * `['facebook','instagram']` when absent (byte-identical to previous behaviour
   * when all flags are OFF).
   */
  allowedPublishPlatforms?: AllowedTargetPlatform[];
}

export default function CalendarPresenter({
  model,
  onSchedule,
  pendingDayKeys,
  schedulingError,
  campaignsLoading,
  onRescheduled,
  allowedPublishPlatforms,
}: CalendarPresenterProps) {
  const timeZone = model.timeZone;
  const [view, setView] = useState<CalendarMode>('month');
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [rescheduleEventId, setRescheduleEventId] = useState<string | null>(null);
  const [scheduleTrayPost, setScheduleTrayPost] = useState<UnscheduledPost | null>(null);

  const sensors = useSensors(
    // A small activation distance keeps a plain click on a tile from being
    // swallowed as a drag (so the event-detail modal still opens).
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // Apply optimistic day-key overrides so a dragged tile shows on the target
  // cell before the server refetch lands.
  const events = useMemo(() => {
    if (!pendingDayKeys || Object.keys(pendingDayKeys).length === 0) {
      return model.events;
    }
    return model.events.map((event) =>
      pendingDayKeys[event.id]
        ? { ...event, dayKey: pendingDayKeys[event.id] }
        : event,
    );
  }, [model.events, pendingDayKeys]);

  const calendarDays = useMemo(() => {
    const weekStartsOn = view === 'month' ? 0 : 1;
    const start =
      view === 'month'
        ? startOfWeek(startOfMonth(currentDate), weekStartsOn)
        : startOfWeek(currentDate, weekStartsOn);
    const end =
      view === 'month'
        ? endOfWeek(endOfMonth(currentDate), weekStartsOn)
        : endOfWeek(currentDate, weekStartsOn);
    return eachDayOfInterval({ start, end });
  }, [currentDate, view]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const entry = map.get(event.dayKey) || [];
      entry.push(event);
      map.set(event.dayKey, entry);
    }
    return map;
  }, [events]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) || null;
  const rescheduleTarget = events.find(
    (event) => event.id === rescheduleEventId && event.jobId,
  ) || null;

  useEffect(() => {
    if (!selectedEvent) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelectedEventId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedEvent]);

  function previousPeriod() {
    setCurrentDate((current) => (view === 'month' ? shiftMonths(current, -1) : shiftDays(current, -7)));
  }

  function nextPeriod() {
    setCurrentDate((current) => (view === 'month' ? shiftMonths(current, 1) : shiftDays(current, 7)));
  }

  function handleDragEnd(dragEvent: DragEndEvent) {
    if (!onSchedule || !dragEvent.over) {
      return;
    }
    const data = dragEvent.active.data.current as DragItemData | undefined;
    const resolved = resolveDragSchedule(data, String(dragEvent.over.id));
    if (resolved) {
      onSchedule(resolved.item, resolved.targetDayKey);
    }
  }

  const todayKey = tenantZoneDateKey(new Date(), timeZone);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="space-y-8 pb-12">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div>
            <div className="mb-2 flex items-center gap-3">
              <div className="rounded-lg bg-white/5 p-2">
                <CalendarIcon className="h-5 w-5 text-violet-300" />
              </div>
              <h2 className="text-3xl font-display font-semibold tracking-tight text-white">Calendar</h2>
            </div>
            <p className="max-w-3xl text-zinc-400">{model.hero.description}</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75">
            <Layers3 className="h-4 w-4 text-violet-300" />
            {events.length} queued post{events.length === 1 ? '' : 's'}
          </div>
        </div>

        {schedulingError ? (
          <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-100">
            {schedulingError}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.78fr_3.22fr]">
          <UnscheduledTray posts={model.unscheduled} onOpenSchedule={setScheduleTrayPost} />

          <div className="space-y-6">
            <section className="glass-panel min-w-0 p-5 md:p-6">
              <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                <div className="flex flex-col gap-4 md:flex-row md:items-center">
                  <h2 className="min-w-[180px] text-2xl font-medium tracking-tight text-white">
                    {formatMonthYear(currentDate)}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={previousPeriod}
                      className="rounded-lg border border-white/10 p-2 transition-colors hover:bg-white/5"
                      aria-label="Previous period"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentDate(new Date())}
                      className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      onClick={nextPeriod}
                      className="rounded-lg border border-white/10 p-2 transition-colors hover:bg-white/5"
                      aria-label="Next period"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                <div className="flex rounded-xl border border-white/5 bg-[#111] p-1">
                  {(['week', 'month'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setView(mode)}
                      className={`px-4 py-2 text-sm font-medium transition-all ${
                        view === mode ? 'rounded-lg bg-[#222] text-white shadow-lg' : 'text-zinc-400 hover:text-zinc-300'
                      }`}
                    >
                      {mode === 'week' ? 'Week' : 'Month'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto no-scrollbar">
                <motion.div
                  key={`${view}:${dateKey(currentDate)}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="min-w-[900px] lg:min-w-0"
                >
                  <div className="mb-4 grid grid-cols-7">
                    {(view === 'month'
                      ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
                      : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
                    ).map((day) => (
                      <div
                        key={day}
                        className="text-center text-[10px] font-bold tracking-[0.3em] text-zinc-400"
                      >
                        {day}
                      </div>
                    ))}
                  </div>

                  <div
                    className={`grid grid-cols-7 ${
                      view === 'month'
                        ? 'gap-px overflow-hidden rounded-2xl border border-white/[0.05] bg-white/[0.05]'
                        : 'gap-3'
                    }`}
                  >
                    {calendarDays.map((day) => {
                      const cellKey = dateKey(day);
                      const cellEvents = (eventsByDay.get(cellKey) || [])
                        .slice()
                        .sort((left, right) => left.timestamp - right.timestamp);
                      const active = cellKey === todayKey;

                      return (
                        <CalendarCell
                          key={cellKey}
                          dayKey={cellKey}
                          view={view}
                          dayNumber={day.getDate()}
                          inCurrentMonth={isSameMonth(day, currentDate)}
                          active={active}
                          events={cellEvents}
                          timeZone={timeZone}
                          onSelectEvent={setSelectedEventId}
                        />
                      );
                    })}
                  </div>
                </motion.div>
              </div>
            </section>

            <section className="glass-panel p-6">
              <h2 className="mb-6 text-lg font-semibold text-white">Social content status at a glance</h2>
              <div className="space-y-4">
                {campaignsLoading ? (
                  <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-400">
                    Loading posts…
                  </div>
                ) : model.posts.length === 0 ? (
                  <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-400">
                    No social content is available yet.
                  </div>
                ) : (
                  model.posts.map((campaign) => (
                    <Link
                      key={campaign.id}
                      href={campaign.href}
                      className="block rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 transition-all hover:border-primary/20 hover:bg-primary/[0.04]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-white">{campaign.name}</p>
                        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusPill(campaign.status)}`}>
                          {formatPostStatusLabel(campaign.status)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-white/55">{campaign.nextScheduled}</p>
                      <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-white/70">
                        <span>{campaign.stageLabel}</span>
                        <span>{campaign.pendingApprovals} pending approvals</span>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        <AnimatePresence>
          {selectedEvent ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setSelectedEventId(null)}
                className="absolute inset-0 bg-black/80 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.92, opacity: 0, y: 18 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 18 }}
                className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-[#0a0a0a] shadow-2xl"
              >
                <div className="flex items-center justify-between border-b border-white/5 p-5 md:p-6">
                  <div>
                    <h2 className="text-xl font-medium text-white">{selectedEvent.title}</h2>
                    <p className="mt-1 text-sm text-zinc-400">{selectedEvent.scheduledFor}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedEventId(null)}
                    className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
                    aria-label="Close"
                  >
                    <CloseIcon className="h-5 w-5" />
                  </button>
                </div>

                <div className="space-y-5 p-5 md:p-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <InfoPanel label="Platform" value={selectedEvent.platform} />
                    <InfoPanel label="Dispatch status" value={formatDispatchStatusLabel(selectedEvent.dispatchStatus)} />
                    <InfoPanel label="Scheduled for" value={selectedEvent.scheduledFor} />
                    <InfoPanel
                      label="Targets"
                      value={selectedEvent.targetPlatforms.join(', ') || selectedEvent.platform}
                    />
                  </div>

                  {selectedEvent.dispatches.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
                        Per-platform dispatch
                      </p>
                      {selectedEvent.dispatches.map((dispatch) => (
                        <div
                          key={dispatch.platform}
                          className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 text-sm"
                        >
                          <span className="text-white/80 capitalize">{dispatch.platform}</span>
                          <span className="text-white/55">
                            {dispatch.status}
                            {dispatch.errorMessage ? ` — ${dispatch.errorMessage}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-3">
                    {selectedEvent.jobId ? (
                      <button
                        type="button"
                        data-testid="calendar-open-reschedule"
                        onClick={() => setRescheduleEventId(selectedEvent.id)}
                        className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-medium text-white transition hover:border-white/30"
                      >
                        <CalendarIcon className="h-4 w-4" />
                        Reschedule
                      </button>
                    ) : null}
                    {selectedEvent.jobId &&
                    (selectedEvent.dispatchStatus === 'pending' ||
                      selectedEvent.dispatchStatus === 'failed') ? (
                      <PublishNowButton
                        jobId={selectedEvent.jobId}
                        postId={selectedEvent.postId}
                        targetPlatforms={selectedEvent.targetPlatforms}
                        platform={selectedEvent.platform}
                        onQueued={() => onRescheduled?.()}
                        onClose={() => setSelectedEventId(null)}
                      />
                    ) : null}
                    {selectedEvent.jobId &&
                    (selectedEvent.dispatchStatus === 'pending' ||
                      selectedEvent.dispatchStatus === 'in_flight') ? (
                      <CancelScheduleButton
                        jobId={selectedEvent.jobId}
                        postId={selectedEvent.postId}
                        dispatchStatus={selectedEvent.dispatchStatus}
                        onCancelled={() => {
                          setSelectedEventId(null);
                          onRescheduled?.();
                        }}
                      />
                    ) : null}
                    <Link
                      href={selectedEvent.href}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)]"
                    >
                      Open post workspace
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>

        {rescheduleTarget ? (
          <RescheduleDrawer
            jobId={rescheduleTarget.jobId as string}
            postId={rescheduleTarget.postId}
            defaultScheduledAt={rescheduleTarget.scheduledForIso}
            defaultPlatforms={rescheduleTarget.targetPlatforms.filter(
              (platform): platform is AllowedTargetPlatform =>
                (allowedPublishPlatforms ?? (['facebook', 'instagram'] as AllowedTargetPlatform[])).includes(
                  platform as AllowedTargetPlatform,
                ),
            )}
            allowedPlatforms={allowedPublishPlatforms}
            timeZone={timeZone}
            onClose={() => setRescheduleEventId(null)}
            onSaved={() => {
              setRescheduleEventId(null);
              setSelectedEventId(null);
              onRescheduled?.();
            }}
          />
        ) : null}

        {scheduleTrayPost?.jobId ? (
          <RescheduleDrawer
            jobId={scheduleTrayPost.jobId}
            postId={scheduleTrayPost.postId}
            defaultPlatforms={
              scheduleTrayPost.platform !== null &&
              (allowedPublishPlatforms ?? (['facebook', 'instagram'] as AllowedTargetPlatform[])).includes(
                scheduleTrayPost.platform as AllowedTargetPlatform,
              )
                ? [scheduleTrayPost.platform as AllowedTargetPlatform]
                : undefined
            }
            allowedPlatforms={allowedPublishPlatforms}
            timeZone={timeZone}
            onClose={() => setScheduleTrayPost(null)}
            onSaved={() => {
              setScheduleTrayPost(null);
              onRescheduled?.();
            }}
          />
        ) : null}
      </div>
    </DndContext>
  );
}

function PublishNowButton({
  jobId,
  postId,
  targetPlatforms,
  platform,
  onQueued,
  onClose,
}: {
  jobId: string;
  postId: string;
  targetPlatforms: string[];
  platform: string;
  onQueued: () => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  async function handlePublishNow() {
    if (submitting || confirmation) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const url = `/api/social-content/jobs/${encodeURIComponent(jobId)}/posts/${encodeURIComponent(postId)}/schedule`;
      // Pass the post's real targets through (filtered to the known set). The
      // server-side normalizeTargetPlatforms is the flag-aware gate, so a target
      // whose rollout flag is off (e.g. youtube when ARIES_YOUTUBE_ENABLED is
      // off) is rejected with invalid_platforms rather than silently rerouted —
      // previously anything outside fb/ig was coerced to facebook (a wrong-network
      // mis-publish once x/reddit/linkedin/youtube became selectable targets).
      const known = new Set<string>(ALLOWED_TARGET_PLATFORMS);
      const filtered = targetPlatforms.filter(
        (p): p is AllowedTargetPlatform => known.has(p),
      );
      const fallback: AllowedTargetPlatform = known.has(platform)
        ? (platform as AllowedTargetPlatform)
        : 'facebook';
      const platforms = filtered.length > 0 ? filtered : [fallback];
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduled_at: new Date().toISOString(),
          platforms,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(payload?.error ?? "Couldn't queue this post — try again.");
        return;
      }
      setConfirmation(true);
      onQueued();
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
      closeTimerRef.current = setTimeout(() => onClose(), 1800);
    } catch {
      setErrorMessage("Couldn't queue this post — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) {
    return (
      <span
        role="status"
        data-testid="calendar-publish-now-queued"
        className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-3 text-sm font-medium text-emerald-100"
      >
        Queued — will publish within a minute
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="calendar-publish-now"
        disabled={submitting}
        onClick={() => void handlePublishNow()}
        className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-500/50 disabled:opacity-60"
      >
        {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
        Publish now
      </button>
      {errorMessage ? (
        <span
          role="alert"
          data-testid="calendar-publish-now-error"
          className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-2 text-sm text-rose-100"
        >
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}

function CancelScheduleButton({
  jobId,
  postId,
  dispatchStatus,
  onCancelled,
}: {
  jobId: string;
  postId: string;
  dispatchStatus: string;
  onCancelled: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isInFlight = dispatchStatus === 'in_flight';

  async function handleCancel() {
    if (submitting || isInFlight) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const url = `/api/social-content/jobs/${encodeURIComponent(jobId)}/posts/${encodeURIComponent(postId)}/schedule`;
      const response = await fetch(url, { method: 'DELETE' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(payload?.error ?? "Couldn't cancel — try again.");
        return;
      }
      onCancelled();
    } catch {
      setErrorMessage("Couldn't cancel — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="calendar-cancel-schedule"
        disabled={submitting || isInFlight}
        title={isInFlight ? "Dispatching to Meta now — can't cancel mid-flight" : undefined}
        onClick={() => void handleCancel()}
        className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-3 text-sm font-medium text-rose-100 transition hover:border-rose-500/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        {isInFlight ? 'Dispatching…' : 'Cancel'}
      </button>
      {errorMessage ? (
        <span
          role="alert"
          data-testid="calendar-cancel-schedule-error"
          className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-2 text-sm text-rose-100"
        >
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}

function UnscheduledTray({
  posts,
  onOpenSchedule,
}: {
  posts: UnscheduledPost[];
  onOpenSchedule: (post: UnscheduledPost) => void;
}) {
  return (
    <section className="glass-panel h-fit p-5">
      <div className="mb-4 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-violet-300" />
        <h2 className="text-sm font-semibold text-white">Backlog</h2>
      </div>
      <p className="mb-4 text-xs leading-5 text-white/70">
        Approved posts with no publish date. Drag onto a calendar cell or click to schedule.
      </p>
      {posts.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 text-xs text-zinc-400">
          No approved posts are waiting to be scheduled.
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <UnscheduledTrayItem key={post.postId} post={post} onClickSchedule={onOpenSchedule} />
          ))}
        </div>
      )}
    </section>
  );
}

function UnscheduledTrayItem({
  post,
  onClickSchedule,
}: {
  post: UnscheduledPost;
  onClickSchedule: (post: UnscheduledPost) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `unscheduled:${post.postId}`,
    data: { kind: 'unscheduled', post },
  });

  const canSchedule = Boolean(post.jobId);

  // WCAG 4.1.2 (nested-interactive): the draggable region carries dnd-kit's
  // role="button" + tabindex=0, so it must NOT contain another focusable
  // control. The Schedule button is a SIBLING of the draggable card, not a
  // descendant — which also removes the pointer/key stopPropagation hacks that
  // previously kept a click on the button from starting a drag.
  return (
    <div className="space-y-2">
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        data-testid={`tray-item-${post.postId}`}
        className={`cursor-grab rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3 transition-all hover:border-primary/25 ${
          isDragging ? 'opacity-40' : ''
        }`}
      >
        {post.imageUrl ? (
          <img
            src={post.imageUrl}
            alt={post.title}
            className="mb-2 h-16 w-full rounded-xl object-cover"
            // Hide rather than render a broken tile if the Hermes asset evicted (404).
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex h-4 w-4 items-center justify-center text-white/70">
            {platformLogo(post.platform || 'meta')}
          </span>
          <span className="text-[9px] font-mono uppercase tracking-[0.16em] text-white/70">
            {post.platform || 'meta'}
          </span>
        </div>
        <p className="text-[11px] font-medium leading-snug text-white/85">{post.title}</p>
      </div>
      {canSchedule ? (
        <button
          type="button"
          data-testid={`tray-item-schedule-${post.postId}`}
          onClick={() => onClickSchedule(post)}
          className="w-full rounded-xl border border-primary/20 bg-primary/10 py-1.5 text-[10px] font-medium text-violet-300 transition hover:border-primary/40 hover:text-violet-300"
        >
          Schedule
        </button>
      ) : null}
    </div>
  );
}

function CalendarCell({
  dayKey,
  view,
  dayNumber,
  inCurrentMonth,
  active,
  events,
  timeZone,
  onSelectEvent,
}: {
  dayKey: string;
  view: CalendarMode;
  dayNumber: number;
  inCurrentMonth: boolean;
  active: boolean;
  events: CalendarEvent[];
  timeZone: string;
  onSelectEvent: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dayKey });

  if (view === 'month') {
    return (
      <div
        ref={setNodeRef}
        data-testid={`cell-${dayKey}`}
        className={`flex min-h-[190px] flex-col bg-[#050505] p-3 transition-all ${
          !inCurrentMonth ? 'opacity-35' : ''
        } ${active ? 'bg-primary/[0.03]' : ''} ${isOver ? 'ring-2 ring-inset ring-primary/60' : ''}`}
      >
        <div className="mb-4 flex items-start justify-between">
          <span className={`text-sm font-medium ${active ? 'text-violet-300' : 'text-zinc-400'}`}>
            {String(dayNumber)}
          </span>
          {active ? (
            <div className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(123,97,255,0.8)]" />
          ) : null}
        </div>
        <div className="flex-1 space-y-1">
          {events.map((event) => (
            <CalendarTile key={event.id} event={event} timeZone={timeZone} onSelect={onSelectEvent} compact />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-testid={`cell-${dayKey}`}
      className={`flex flex-col overflow-hidden rounded-2xl border border-white/[0.03] bg-white/[0.01] p-2 ${
        isOver ? 'ring-2 ring-inset ring-primary/60' : ''
      }`}
    >
      <div className="mb-3 flex items-center justify-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
            active ? 'bg-primary text-white shadow-[0_0_10px_rgba(123,97,255,0.45)]' : 'text-zinc-50'
          }`}
        >
          {String(dayNumber)}
        </div>
      </div>
      <div className="flex-1 space-y-3">
        {events.map((event) => (
          <CalendarTile key={event.id} event={event} timeZone={timeZone} onSelect={onSelectEvent} />
        ))}
      </div>
    </div>
  );
}

function CalendarTile({
  event,
  timeZone,
  onSelect,
  compact,
}: {
  event: CalendarEvent;
  timeZone: string;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `event:${event.id}`,
    data: { kind: 'event', event },
  });
  const time = formatTimeInTenantZone(event.scheduledForIso, timeZone);

  if (compact) {
    return (
      <button
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        data-testid={`tile-${event.id}`}
        onClick={() => onSelect(event.id)}
        className={`w-full cursor-grab rounded border px-2.5 py-2 text-left text-[9px] transition-all hover:bg-white/[0.05] ${platformTone(
          event.platform,
        )} ${isDragging ? 'opacity-40' : ''}`}
      >
        <div className="flex items-center justify-between gap-2 text-[8px] font-mono uppercase tracking-[0.14em]">
          <span className="text-white">{time}</span>
          <span className="flex h-4 w-4 items-center justify-center text-white">
            {platformLogo(event.platform)}
          </span>
        </div>
        <span
          className="mt-2.5 block overflow-hidden text-[9px] font-normal leading-snug text-white"
          style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
        >
          {event.title}
        </span>
      </button>
    );
  }

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      data-testid={`tile-${event.id}`}
      onClick={() => onSelect(event.id)}
      className={`w-full cursor-grab rounded-2xl border bg-[#0a0a0a]/80 p-3 text-left shadow-lg transition-all ${platformTone(
        event.platform,
      )} ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-mono opacity-70">{time}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[7px] font-bold uppercase tracking-widest ${statusPill(
            event.status,
          )}`}
        >
          {formatDispatchStatusChip(event.dispatchStatus)}
        </span>
      </div>
      <h3 className="mb-1 text-[11px] font-bold leading-tight text-white">{event.title}</h3>
      <div className="flex items-center gap-2 text-white/85">
        <span className="flex h-4 w-4 items-center justify-center">{platformLogo(event.platform)}</span>
      </div>
    </button>
  );
}

function platformTone(platform: string) {
  const key = platform.toLowerCase();
  if (key.includes('meta')) return 'border-sky-500/40 text-sky-300 bg-sky-500/5';
  if (key.includes('linkedin')) return 'border-blue-500/40 text-blue-400 bg-blue-500/5';
  if (key.includes('instagram')) return 'border-pink-500/40 text-pink-400 bg-pink-500/5';
  if (key.includes('reddit')) return 'border-orange-500/40 text-orange-300 bg-orange-500/5';
  if (key.includes('youtube')) return 'border-red-500/40 text-red-400 bg-red-500/5';
  if (key.includes('facebook')) return 'border-sky-500/40 text-sky-300 bg-sky-500/5';
  if (key.includes('x')) return 'border-zinc-400/40 text-zinc-300 bg-zinc-400/5';
  return 'border-primary/40 text-violet-300 bg-primary/5';
}

function platformLogo(platform: string) {
  const key = platform.toLowerCase();
  const iconClassName = 'h-3.5 w-3.5 text-white';

  if (key.includes('meta') || key.includes('facebook')) return <FacebookIcon className={iconClassName} />;
  if (key.includes('linkedin')) return <LinkedinIcon className={iconClassName} />;
  if (key.includes('instagram')) return <InstagramIcon className={iconClassName} />;
  if (key.includes('youtube')) return <YoutubeIcon className={iconClassName} />;
  if (key.includes('reddit')) return <RedditIcon className={iconClassName} />;
  if (key.includes('x')) return <XIcon className={iconClassName} />;
  if (key.includes('tiktok')) return <Music2 className={iconClassName} />;
  return <Globe className={iconClassName} />;
}

function statusPill(status: string) {
  if (status === 'live') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
  if (status === 'scheduled') return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
  if (status === 'approved') return 'border-indigo-400/25 bg-indigo-400/10 text-indigo-100';
  if (status === 'in_review') return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
  if (status === 'changes_requested') return 'border-rose-400/25 bg-rose-400/10 text-rose-100';
  return 'border-white/15 bg-white/7 text-white/75';
}

function InfoPanel(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">{props.label}</p>
      <p className="mt-2 text-sm text-white/80">{props.value}</p>
    </div>
  );
}

/**
 * Tz-aware grid date helpers (C1 / T10). The browser-local `Date` used for the
 * month/week skeleton is matched against tenant-zone day keys via `dateKey`,
 * which derives its YYYY-MM-DD from the date's local civil fields — the same
 * fields `tenantZoneDateKey` produces for an instant. The grid skeleton is
 * still a local `Date` walk (cheap, zone-agnostic for "which 42 cells"); only
 * the event-to-cell match and "today" use tenant-zone keys.
 */

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date: Date, weekStartsOn: number): Date {
  const clone = stripTime(date);
  const diff = (clone.getDay() - weekStartsOn + 7) % 7;
  clone.setDate(clone.getDate() - diff);
  return clone;
}

function endOfWeek(date: Date, weekStartsOn: number): Date {
  return shiftDays(startOfWeek(date, weekStartsOn), 6);
}

function eachDayOfInterval(interval: { start: Date; end: Date }): Date[] {
  const days: Date[] = [];
  let current = stripTime(interval.start);
  const end = stripTime(interval.end);
  while (current.getTime() <= end.getTime()) {
    days.push(current);
    current = shiftDays(current, 1);
  }
  return days;
}

function shiftDays(date: Date, amount: number): Date {
  const clone = stripTime(date);
  clone.setDate(clone.getDate() + amount);
  return clone;
}

function shiftMonths(date: Date, amount: number): Date {
  const clone = stripTime(date);
  clone.setMonth(clone.getMonth() + amount);
  return clone;
}

function isSameMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function stripTime(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMonthYear(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date);
}
