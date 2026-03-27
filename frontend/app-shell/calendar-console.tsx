'use client';

import Link from 'next/link';

import { useState, type FormEvent } from 'react';
import { CalendarDays, Sparkles } from 'lucide-react';

import type { MarketingCalendarEvent } from '@/lib/api/marketing';
import { useCalendarSync } from '@/hooks/use-calendar-sync';
import { useLatestMarketingJob } from '@/hooks/use-latest-marketing-job';

function iterateUtcDaysInclusive(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const final = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= final) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function buildCurrentMonthDays(): Date[] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return iterateUtcDaysInclusive(start, end);
}

function buildCalendarDays(startIso?: string | null, endIso?: string | null): Date[] {
  if (!startIso || !endIso) {
    return buildCurrentMonthDays();
  }
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return buildCurrentMonthDays();
  }

  return iterateUtcDaysInclusive(start, end);
}

export default function CalendarConsole(): JSX.Element {
  const calendarSync = useCalendarSync();
  const latestJob = useLatestMarketingJob({ autoLoad: true });
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const campaign = latestJob.data;
  const days = buildCalendarDays(campaign?.campaignWindow?.start, campaign?.campaignWindow?.end);
  const windowLabel = campaign?.campaignWindow?.start && campaign?.campaignWindow?.end
    ? `${campaign.campaignWindow.start} to ${campaign.campaignWindow.end}`
    : `${days[0]?.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) ?? 'Current month'}`;

  const eventsByDay = new Map<string, MarketingCalendarEvent[]>();
  for (const event of campaign?.calendarEvents ?? []) {
    const key = event.startsAt.slice(0, 10);
    const existing = eventsByDay.get(key) ?? [];
    existing.push(event);
    eventsByDay.set(key, existing);
  }

  async function handleSync(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await calendarSync.sync({
      window_start: windowStart.trim() || undefined,
      window_end: windowEnd.trim() || undefined,
    });
  }

  return (
    <div className="space-y-6">
      <div className="glass rounded-[2.5rem] p-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Campaign calendar</p>
            <h2 className="text-3xl font-bold mb-3">Monthly content view</h2>
            <p className="text-white/60 leading-relaxed max-w-2xl">
              Review the live campaign window, scheduled posts, and linked preview assets for the current tenant.
            </p>
          </div>
          <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70">
            Days in campaign: <strong className="text-white">{campaign?.durationDays ?? 0}</strong>
          </div>
        </div>
      </div>

      <div className="grid xl:grid-cols-[1.25fr_0.75fr] gap-6">
        <div className="glass rounded-[2.5rem] p-8">
          {latestJob.isLoading ? (
            <div className="text-white/60">Loading campaign calendar…</div>
          ) : (
            <div className="space-y-6">
              {!campaign ? (
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/65">
                  No active campaign found. Showing the current month so your team can still plan and verify schedule coverage.
                </div>
              ) : null}
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <CalendarDays className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-white/35">Window</p>
                  <h3 className="text-2xl font-bold">{windowLabel}</h3>
                </div>
              </div>
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                {days.map((day) => {
                  const key = day.toISOString().slice(0, 10);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  return (
                    <div key={key} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4 min-h-[180px]">
                      <div className="mb-4">
                        <p className="text-xs uppercase tracking-[0.22em] text-white/35">{day.toLocaleDateString(undefined, { weekday: 'short' })}</p>
                        <h4 className="text-xl font-semibold">{day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</h4>
                      </div>
                      <div className="space-y-3">
                        {dayEvents.length === 0 ? (
                          <div className="text-sm text-white/40">No scheduled post</div>
                        ) : (
                          dayEvents.map((event) => (
                            <div key={event.id} className="rounded-[1.25rem] border border-white/10 bg-black/20 p-3">
                              <div className="text-[11px] uppercase tracking-[0.2em] text-white/35 mb-2">{event.platform}</div>
                              <div className="font-medium mb-1">{event.title}</div>
                              <div className="text-sm text-white/55">{event.status}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="glass rounded-[2.5rem] p-8">
            <form onSubmit={handleSync} className="space-y-6">
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-secondary" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-white/35">Aries schedule sync</p>
                    <h2 className="text-2xl font-bold">Sync calendar state</h2>
                  </div>
                </div>
                <p className="text-white/60 leading-relaxed">
                  Keep the campaign calendar aligned with the latest workflow-backed schedule window.
                </p>
              </div>

              <label className="block space-y-2">
                <span className="text-xs uppercase tracking-[0.22em] text-white/35">Window start</span>
                <input
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                  placeholder="2026-04-01T00:00:00Z"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </label>

              <label className="block space-y-2">
                <span className="text-xs uppercase tracking-[0.22em] text-white/35">Window end</span>
                <input
                  value={windowEnd}
                  onChange={(event) => setWindowEnd(event.target.value)}
                  placeholder="2026-04-30T23:59:59Z"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </label>

              <button
                type="submit"
                disabled={calendarSync.isLoading}
                className="w-full px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
              >
                {calendarSync.isLoading ? 'Syncing…' : 'Run calendar sync'}
              </button>

              {calendarSync.error ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
                  {calendarSync.error.message}
                </div>
              ) : null}
              {calendarSync.data ? (
                <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 overflow-x-auto font-mono text-sm text-white/75">
                  {JSON.stringify(calendarSync.data, null, 2)}
                </div>
              ) : null}
            </form>
          </div>

          <div className="glass rounded-[2.5rem] p-8">
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Campaign actions</p>
            <div className="flex flex-col gap-3">
              <Link href={campaign ? `/marketing/job-status?jobId=${encodeURIComponent(campaign.jobId)}` : '/marketing/new-job'} className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                {campaign ? 'Open campaign status' : 'Launch campaign'}
              </Link>
              {campaign?.approval?.actionHref ? (
                <Link href={campaign.approval.actionHref} className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                  Open approval
                </Link>
              ) : null}
              <Link href="/dashboard/posts" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                Open post queue
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
