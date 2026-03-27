'use client';

import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';

import { EmptyStatePanel, LoadingStateGrid, ScheduleComposer, ShellPanel, StatusChip } from './components';

export default function AriesCalendarScreen() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const items = campaigns.data?.campaigns ?? [];
  const schedule = items
    .flatMap((campaign) => campaign.dashboard.calendarEvents)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .map((event) => ({
      id: event.id,
      title: event.title,
      channel: `${event.campaignName} · ${event.platformLabel} · ${event.statusLabel}`,
      scheduledFor: event.startsAt,
      status: event.status,
    }));

  if (campaigns.isLoading) {
    return <LoadingStateGrid />;
  }

  if (campaigns.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{campaigns.error.message}</div>;
  }

  if (schedule.length === 0) {
    return (
      <EmptyStatePanel
        title="Nothing is scheduled yet"
        description="Approved work will appear here once campaigns are ready to place on the calendar."
      />
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Calendar" title="What is going out and when">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Aries keeps the schedule human-readable. Live platform events appear first when they exist, and the calendar stays populated with truthful planned or ready-to-publish items when only internal campaign artifacts are available.
        </p>
      </ShellPanel>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <ShellPanel eyebrow="Schedule" title="Upcoming work">
          <ScheduleComposer items={schedule} />
        </ShellPanel>
        <ShellPanel eyebrow="Campaigns" title="Status at a glance">
          <div className="space-y-3">
            {items.map((campaign) => (
              <div key={campaign.id} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white">{campaign.name}</p>
                  <StatusChip status={campaign.dashboardStatus} />
                </div>
                <p className="mt-2 text-sm text-white/55">{campaign.nextScheduled}</p>
                <p className="mt-2 text-xs uppercase tracking-[0.18em] text-white/35">
                  {campaign.counts.readyToPublish} ready to publish · {campaign.counts.pausedMetaAds} paused in Meta
                </p>
              </div>
            ))}
          </div>
        </ShellPanel>
      </div>
    </div>
  );
}
