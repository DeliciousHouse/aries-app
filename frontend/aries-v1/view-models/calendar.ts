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
    status: RuntimeCampaignListItem['status'];
    href: string;
    timestamp: number;
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

function isScheduledValue(value: string): boolean {
  return !value.startsWith('Nothing') && !value.startsWith('Waiting');
}

function parseScheduledValue(value: string): { timestamp: number; platform: string; label: string } | null {
  const [startsAt, platform] = value.split(' · ');
  const timestamp = Date.parse(startsAt);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return {
    timestamp,
    platform: platform || 'Scheduled',
    label: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp)),
  };
}

export function createCalendarViewModel(campaigns: RuntimeCampaignListItem[]): CalendarViewModel {
  const events = campaigns
    .filter((campaign) => isScheduledValue(campaign.nextScheduled))
    .map((campaign) => {
      const parsed = parseScheduledValue(campaign.nextScheduled);
      if (!parsed) {
        return null;
      }

      return {
        id: `${campaign.id}::next`,
        title: campaign.name,
        platform: parsed.platform,
        scheduledFor: parsed.label,
        status: campaign.status,
        href: `/dashboard/campaigns/${campaign.id}`,
        timestamp: parsed.timestamp,
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

  return {
    hero: {
      eyebrow: 'Calendar',
      title: 'What is going out and when',
      description:
        'This calendar restores the richer dashboard composition, but it only renders schedule signals that already exist in the live runtime.',
      metrics: [
        {
          label: 'Upcoming items',
          value: String(events.length),
          detail: events.length > 0 ? 'Schedule windows are coming from runtime-backed campaigns.' : 'Nothing is scheduled yet.',
        },
        {
          label: 'Ready to run',
          value: String(readyCount),
          detail:
            readyCount > 0
              ? 'Scheduled or live campaigns are represented here.'
              : 'No campaigns are ready for publish windows yet.',
          tone: readyCount > 0 ? 'good' : 'default',
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
