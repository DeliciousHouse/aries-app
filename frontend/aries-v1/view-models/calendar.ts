import type { RuntimeCampaignListItem } from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';

export interface CalendarViewModel {
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  events: Array<{
    id: string;
    title: string;
    platform: string;
    scheduledFor: string;
    status: RuntimeCampaignListItem['status'] | RuntimeCampaignListItem['dashboardStatus'];
    href: string;
    timestamp: number;
    dayKey: string;
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    status: RuntimeCampaignListItem['status'];
    nextScheduled: string;
    stageLabel: string;
    pendingApprovals: string;
    href: string;
  }>;
}

function formatScheduledLabel(value: string, campaignName: string, statusLabel: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return `${campaignName} · ${statusLabel}`;
  }

  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC · ${campaignName} · ${statusLabel}`;
}

function normalizeCalendarPlatformLabel(platformLabel: string): string {
  if (platformLabel.trim().toLowerCase() === 'landing page') {
    return 'Reddit';
  }

  return platformLabel;
}

export function createCalendarViewModel(campaigns: RuntimeCampaignListItem[]): CalendarViewModel {
  const events = campaigns
    .flatMap((campaign) => campaign.dashboard.calendarEvents.map((event) => ({ campaign, event })))
    .map(({ campaign, event }) => {
      const timestamp = Date.parse(event.startsAt);
      if (!Number.isFinite(timestamp)) {
        return null;
      }

      return {
        id: event.id,
        title: event.title,
        platform: normalizeCalendarPlatformLabel(event.platformLabel),
        scheduledFor: formatScheduledLabel(event.startsAt, event.campaignName, event.statusLabel),
        status: event.status,
        href: `/dashboard/campaigns/${campaign.id}`,
        timestamp,
        dayKey: event.startsAt.slice(0, 10),
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== null)
    .sort((left, right) => left.timestamp - right.timestamp);

  const readyCount = campaigns.filter(
    (campaign) => campaign.status === 'scheduled' || campaign.status === 'live',
  ).length;
  const approvalCount = campaigns.filter(
    (campaign) => campaign.pendingApprovals > 0 || campaign.status === 'in_review',
  ).length;
  const scheduledCount = events.filter((event) => event.status === 'scheduled' || event.status === 'live').length;

  return {
    hero: {
      eyebrow: 'Calendar',
      title: 'What is going out and when',
      description:
        'A month-at-a-glance view of everything scheduled to go out — every tile reflects a real campaign step.',
      metrics: [
        {
          label: 'Upcoming items',
          value: String(events.length),
          detail: events.length > 0 ? 'Calendar tiles are populated from runtime-backed schedule events.' : 'Nothing is scheduled yet.',
        },
        {
          label: 'Scheduled or live',
          value: String(scheduledCount || readyCount),
          detail:
            scheduledCount > 0 || readyCount > 0
              ? 'These items already have real publish windows or live delivery status.'
              : 'No campaigns are ready for publish windows yet.',
          tone: scheduledCount > 0 || readyCount > 0 ? 'good' : 'default',
        },
        {
          label: 'Approval blockers',
          value: String(approvalCount),
          detail:
            approvalCount > 0
              ? 'These campaigns still need a decision before launch can progress.'
              : 'No campaigns are currently blocked on approval.',
          tone: approvalCount > 0 ? 'watch' : 'good',
        },
        {
          label: 'Campaigns tracked',
          value: String(campaigns.length),
          detail: 'Every visible campaign contributes to the calendar summary.',
        },
      ],
    },
    events,
    campaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      nextScheduled: campaign.nextScheduled,
      stageLabel: campaign.stageLabel,
      pendingApprovals: String(campaign.pendingApprovals),
      href: `/dashboard/campaigns/${campaign.id}`,
    })),
  };
}
