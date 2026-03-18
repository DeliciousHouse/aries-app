'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
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
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <form onSubmit={handleSync} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Calendar sync</p>
            <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
              Trigger a schedule sync through Aries
            </h2>
            <p className="rd-section-description">
              Sync windows remain internal-route driven and keep publish scheduling out of direct browser-to-gateway traffic.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Window start</span>
            <TextInput value={windowStart} onChange={(event) => setWindowStart(event.target.value)} placeholder="2026-03-20T00:00:00Z" />
          </label>

          <label className="rd-field">
            <span className="rd-label">Window end</span>
            <TextInput value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} placeholder="2026-03-27T23:59:59Z" />
          </label>

          <Button type="submit" disabled={calendarSync.isLoading}>
            {calendarSync.isLoading ? 'Syncing…' : 'Run calendar sync'}
          </Button>

          {calendarSync.error ? (
            <div className="rd-alert rd-alert--danger">{calendarSync.error.message}</div>
          ) : null}
          {calendarSync.data ? (
            <div className="rd-json-panel"><code>{JSON.stringify(calendarSync.data, null, 2)}</code></div>
          ) : null}
        </form>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Scheduling model</p>
          <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
            Publish windows stay workflow-aware
          </h2>
          <p className="rd-section-description">
            Calendar operations are treated as route-driven orchestration actions. They read and sync state without exposing workflow artifacts or file paths to the client.
          </p>
          <div className="rd-summary-list">
            {[
              'Use windowed syncs for focused remediation or rechecks.',
              'Keep publish dispatch and retry controls in the posts route.',
              'Review platform health before scheduling high-volume releases.',
            ].map((item) => (
              <div key={item} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
                {item}
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
