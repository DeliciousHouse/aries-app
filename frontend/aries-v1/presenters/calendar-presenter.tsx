'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Facebook,
  Globe,
  Instagram,
  Layers3,
  Linkedin,
  Music2,
  Youtube,
  X as CloseIcon,
} from 'lucide-react';

import type { CalendarViewModel } from '@/frontend/aries-v1/view-models/calendar';
import { RedditIcon, XIcon } from '@/frontend/components/Icons';

type CalendarMode = 'week' | 'month';

export interface CalendarPresenterProps {
  model: CalendarViewModel;
}

export default function CalendarPresenter({ model }: CalendarPresenterProps) {
  const [view, setView] = useState<CalendarMode>('month');
  const [currentDate, setCurrentDate] = useState(() => getInitialCalendarDate(model.events));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const calendarDays = useMemo(() => {
    const weekStartsOn = view === 'month' ? 0 : 1;
    const start = view === 'month'
      ? startOfWeek(startOfMonth(currentDate), weekStartsOn)
      : startOfWeek(currentDate, weekStartsOn);
    const end = view === 'month'
      ? endOfWeek(endOfMonth(currentDate), weekStartsOn)
      : endOfWeek(currentDate, weekStartsOn);

    return eachDayOfInterval({ start, end });
  }, [currentDate, view]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarViewModel['events']>();
    for (const event of model.events) {
      const key = event.dayKey || dateKey(new Date(event.timestamp));
      const entry = map.get(key) || [];
      entry.push(event);
      map.set(key, entry);
    }
    return map;
  }, [model.events]);

  const selectedEvent = model.events.find((event) => event.id === selectedEventId) || null;

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

  return (
    <div className="space-y-8 pb-12">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <div className="rounded-lg bg-white/5 p-2">
              <CalendarIcon className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-semibold tracking-tight text-white">Calendar</h1>
          </div>
          <p className="max-w-3xl text-zinc-500">{model.hero.description}</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75">
          <Layers3 className="h-4 w-4 text-primary" />
          {model.events.length} upcoming runtime event{model.events.length === 1 ? '' : 's'}
        </div>
      </div>

      {model.events.length === 0 ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="glass-panel p-8">
            <h2 className="text-2xl font-semibold text-white">Nothing is scheduled yet</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
              The restored calendar layout is in place, but it stays honest. Events only appear once the live runtime publishes real schedule signals.
            </p>
            <div className="mt-6 rounded-2xl border border-primary/10 bg-primary/5 p-5 text-sm leading-relaxed text-white/60">
              Aries will keep this board read-only until there is trustworthy schedule data to render.
            </div>
          </div>

          <div className="glass-panel p-6">
            <h2 className="mb-6 text-lg font-semibold text-white">Campaign status at a glance</h2>
            <div className="space-y-4">
              {model.campaigns.length === 0 ? (
                <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-500">
                  No campaigns are available yet.
                </div>
              ) : (
                model.campaigns.map((campaign) => (
                  <Link
                    key={campaign.id}
                    href={campaign.href}
                    className="block rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 transition-all hover:border-primary/20 hover:bg-primary/[0.04]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">{campaign.name}</p>
                      <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusPill(campaign.status)}`}>
                        {campaign.status.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-white/55">{campaign.nextScheduled}</p>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-white/35">
                      <span>{campaign.stageLabel}</span>
                      <span>{campaign.pendingApprovals} pending approvals</span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
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
                      view === mode ? 'rounded-lg bg-[#222] text-white shadow-lg' : 'text-zinc-500 hover:text-zinc-300'
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
                    : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']).map((day) => (
                    <div
                      key={day}
                      className="text-center text-[10px] font-bold tracking-[0.3em] text-zinc-600"
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
                    const dayKey = dateKey(day);
                    const events = (eventsByDay.get(dayKey) || []).slice().sort((left, right) => left.timestamp - right.timestamp);
                    const active = isToday(day);

                    if (view === 'month') {
                      return (
                        <div
                          key={dayKey}
                          className={`flex min-h-[190px] flex-col bg-[#050505] p-3 transition-all ${
                            !isSameMonth(day, currentDate) ? 'opacity-35' : ''
                          } ${active ? 'bg-primary/[0.03]' : ''}`}
                        >
                          <div className="mb-4 flex items-start justify-between">
                            <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-zinc-500'}`}>
                              {String(day.getDate())}
                            </span>
                            {active ? <div className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(123,97,255,0.8)]" /> : null}
                          </div>

                          <div className="flex-1 space-y-1">
                            {events.map((event) => (
                              <button
                                key={event.id}
                                type="button"
                                onClick={() => setSelectedEventId(event.id)}
                                className={`w-full rounded border px-2.5 py-2 text-left text-[9px] transition-all hover:bg-white/[0.05] ${platformTone(event.platform)}`}
                              >
                                <div className="flex items-center justify-between gap-2 text-[8px] font-mono uppercase tracking-[0.14em]">
                                  <span className="text-white">{formatTime(new Date(event.timestamp))}</span>
                                  <span className="flex h-4 w-4 items-center justify-center text-white">
                                    {platformLogo(event.platform)}
                                  </span>
                                </div>
                                <span
                                  className="mt-2.5 block overflow-hidden text-[9px] font-normal leading-snug text-white"
                                  style={{
                                    display: '-webkit-box',
                                    WebkitBoxOrient: 'vertical',
                                    WebkitLineClamp: 2,
                                  }}
                                >
                                  {event.title}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={dayKey}
                        className="flex flex-col overflow-hidden rounded-2xl border border-white/[0.03] bg-white/[0.01] p-2"
                      >
                        <div className="mb-3 flex items-center justify-center">
                          <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                            active ? 'bg-primary text-white shadow-[0_0_10px_rgba(123,97,255,0.45)]' : 'text-zinc-50'
                          }`}>
                            {String(day.getDate())}
                          </div>
                        </div>
                        <div className="flex-1 space-y-3">
                          {events.length === 0 ? null : (
                            events.map((event) => (
                              <button
                                key={event.id}
                                type="button"
                                onClick={() => setSelectedEventId(event.id)}
                                className={`w-full rounded-2xl border bg-[#0a0a0a]/80 p-3 text-left shadow-lg transition-all ${platformTone(event.platform)}`}
                              >
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="text-[10px] font-mono opacity-70">
                                    {formatTime(new Date(event.timestamp))}
                                  </span>
                                  <span className={`rounded-full border px-2 py-0.5 text-[7px] font-bold uppercase tracking-widest ${statusPill(event.status)}`}>
                                    {event.status === 'live' ? 'Live' : event.status === 'scheduled' ? 'Sch' : 'Prep'}
                                  </span>
                                </div>
                                <h3 className="mb-1 text-[11px] font-bold leading-tight text-white">{event.title}</h3>
                                <div className="flex items-center gap-2 text-white/85">
                                  <span className="flex h-4 w-4 items-center justify-center">
                                    {platformLogo(event.platform)}
                                  </span>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          </section>

          <section className="glass-panel p-6">
            <h2 className="mb-6 text-lg font-semibold text-white">Campaign status at a glance</h2>
            <div className="space-y-4">
              {model.campaigns.map((campaign) => (
                <Link
                  key={campaign.id}
                  href={campaign.href}
                  className="block rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 transition-all hover:border-primary/20 hover:bg-primary/[0.04]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-white">{campaign.name}</p>
                    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusPill(campaign.status)}`}>
                      {campaign.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-white/55">{campaign.nextScheduled}</p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-white/35">
                    <span>{campaign.stageLabel}</span>
                    <span>{campaign.pendingApprovals} pending approvals</span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </div>
      )}

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
                  <p className="mt-1 text-sm text-zinc-500">{selectedEvent.scheduledFor}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedEventId(null)}
                  className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-5 p-5 md:p-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoPanel label="Platform" value={selectedEvent.platform} />
                  <InfoPanel label="Status" value={selectedEvent.status.replace('_', ' ')} />
                  <InfoPanel label="Scheduled for" value={selectedEvent.scheduledFor} />
                  <InfoPanel label="Runtime" value="Read-only schedule signal" />
                </div>

                <div className="rounded-2xl border border-primary/10 bg-primary/5 p-5 text-sm leading-relaxed text-white/65">
                  This calendar view is intentionally read-only. It mirrors the current runtime schedule without inventing additional posts, windows, or generated content.
                </div>

                <Link
                  href={selectedEvent.href}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)]"
                >
                  Open campaign workspace
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </div>
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
  return 'border-primary/40 text-primary bg-primary/5';
}

function platformLogo(platform: string) {
  const key = platform.toLowerCase();
  const iconClassName = 'h-3.5 w-3.5 text-white';

  if (key.includes('meta') || key.includes('facebook')) return <Facebook className={iconClassName} />;
  if (key.includes('linkedin')) return <Linkedin className={iconClassName} />;
  if (key.includes('instagram')) return <Instagram className={iconClassName} />;
  if (key.includes('youtube')) return <Youtube className={iconClassName} />;
  if (key.includes('reddit')) return <RedditIcon className={iconClassName} />;
  if (key.includes('x')) return <XIcon className={iconClassName} />;
  if (key.includes('tiktok')) return <Music2 className={iconClassName} />;
  return <Globe className={iconClassName} />;
}

function statusPill(status: CalendarViewModel['events'][number]['status']) {
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm text-white/80">{props.value}</p>
    </div>
  );
}

function getInitialCalendarDate(events: CalendarViewModel['events']): Date {
  const now = Date.now();
  const nextUpcoming = events.find((event) => event.timestamp >= now);
  if (nextUpcoming) {
    return new Date(nextUpcoming.timestamp);
  }

  if (events[0]) {
    return new Date(events[0].timestamp);
  }

  return new Date();
}

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

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function isSameDay(left: Date, right: Date): boolean {
  return dateKey(left) === dateKey(right);
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
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
