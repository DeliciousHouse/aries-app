'use client';

import { useState, type FormEvent } from 'react';
import { CalendarDays, Sparkles } from 'lucide-react';

import { useCalendarSync } from '@/hooks/use-calendar-sync';

export default function CalendarConsole(): JSX.Element {
  const calendarSync = useCalendarSync();
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  async function handleSync(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await calendarSync.sync({
      window_start: windowStart.trim() || undefined,
      window_end: windowEnd.trim() || undefined,
    });
  }

  return (
    <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={handleSync} className="space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <CalendarDays className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Aries schedule sync</p>
                <h2 className="text-2xl font-bold">Trigger a schedule sync through Aries</h2>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Sync windows remain internal-route driven and keep publish scheduling out of direct browser-to-gateway traffic.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Window start</span>
            <input
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
              placeholder="2026-03-20T00:00:00Z"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Window end</span>
            <input
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
              placeholder="2026-03-27T23:59:59Z"
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

      <div className="glass rounded-[2.5rem] p-8 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Scheduling model</p>
              <h2 className="text-2xl font-bold">Publish windows stay workflow-aware</h2>
            </div>
          </div>
          <p className="text-white/60 leading-relaxed">
            Calendar operations are treated as route-driven orchestration actions. They read and sync state without exposing workflow artifacts or file paths to the client.
          </p>
        </div>

        <div className="space-y-3">
          {[
            'Use windowed syncs for focused remediation or rechecks.',
            'Keep publish dispatch and retry controls in the posts route.',
            'Review platform health before scheduling high-volume releases.',
          ].map((item) => (
            <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/75">
              {item}
            </div>
          ))}
        </div>

        <a href="/posts" className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors">
          Open publish controls <Sparkles className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}
