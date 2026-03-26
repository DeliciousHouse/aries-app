import type { AriesCampaignStatus, RuntimeCampaignListItem } from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';

export interface ResultsViewModel {
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  filters: Array<{
    id: 'all' | AriesCampaignStatus | 'needs_review';
    label: string;
    count: number;
    color: string;
  }>;
  statusBreakdown: Array<{
    id: AriesCampaignStatus;
    label: string;
    count: number;
    color: string;
  }>;
  stageBreakdown: Array<{
    label: string;
    count: number;
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    summary: string;
    status: RuntimeCampaignListItem['status'];
    trustNote: string;
    objective: string;
    stageLabel: string;
    nextScheduled: string;
    updatedLabel: string;
    pendingApprovals: string;
    href: string;
    needsReview: boolean;
  }>;
}

const STATUS_META: Record<AriesCampaignStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: '#6b7280' },
  in_review: { label: 'In review', color: '#f59e0b' },
  approved: { label: 'Approved', color: '#818cf8' },
  scheduled: { label: 'Scheduled', color: '#38bdf8' },
  live: { label: 'Live', color: '#34d399' },
  changes_requested: { label: 'Needs changes', color: '#fb7185' },
};

function formatUpdatedLabel(updatedAt: string | null): string {
  if (!updatedAt) {
    return 'Updated recently';
  }

  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return 'Updated recently';
  }

  return `Updated ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))}`;
}

export function createResultsViewModel(campaigns: RuntimeCampaignListItem[]): ResultsViewModel {
  const liveCount = campaigns.filter((campaign) => campaign.status === 'live').length;
  const scheduledCount = campaigns.filter((campaign) => campaign.status === 'scheduled').length;
  const approvalCount = campaigns.filter(
    (campaign) => campaign.pendingApprovals > 0 || campaign.status === 'in_review',
  ).length;
  const stageCounts = new Map<string, number>();

  for (const campaign of campaigns) {
    stageCounts.set(campaign.stageLabel, (stageCounts.get(campaign.stageLabel) || 0) + 1);
  }

  return {
    hero: {
      eyebrow: 'Results',
      title: 'Runtime-backed campaign outcomes',
      description:
        'This screen restores the richer dashboard presentation, but every card and chart still comes from the live campaign runtime instead of demo analytics.',
      metrics: [
        {
          label: 'Tracked campaigns',
          value: String(campaigns.length),
          detail:
            campaigns.length > 0
              ? 'Every runtime-backed campaign is included in this view.'
              : 'Create the first campaign to populate this surface.',
        },
        {
          label: 'Live now',
          value: String(liveCount),
          detail: liveCount > 0 ? 'These campaigns are actively running.' : 'No campaigns are live yet.',
          tone: liveCount > 0 ? 'good' : 'default',
        },
        {
          label: 'Scheduled',
          value: String(scheduledCount),
          detail:
            scheduledCount > 0
              ? 'These campaigns already have upcoming publish windows.'
              : 'Nothing is scheduled yet.',
        },
        {
          label: 'Needs review',
          value: String(approvalCount),
          detail:
            approvalCount > 0
              ? 'Approvals still block some campaigns before they can progress.'
              : 'No campaigns are currently paused on review.',
          tone: approvalCount > 0 ? 'watch' : 'good',
        },
      ],
    },
    filters: [
      { id: 'all', label: 'All campaigns', count: campaigns.length, color: '#7b61ff' },
      { id: 'live', label: 'Live now', count: liveCount, color: STATUS_META.live.color },
      { id: 'scheduled', label: 'Scheduled', count: scheduledCount, color: STATUS_META.scheduled.color },
      { id: 'needs_review', label: 'Needs review', count: approvalCount, color: STATUS_META.in_review.color },
      {
        id: 'changes_requested',
        label: 'Needs changes',
        count: campaigns.filter((campaign) => campaign.status === 'changes_requested').length,
        color: STATUS_META.changes_requested.color,
      },
    ],
    statusBreakdown: (Object.keys(STATUS_META) as AriesCampaignStatus[]).map((status) => ({
      id: status,
      label: STATUS_META[status].label,
      count: campaigns.filter((campaign) => campaign.status === status).length,
      color: STATUS_META[status].color,
    })),
    stageBreakdown: Array.from(stageCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count),
    campaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      summary: campaign.summary,
      status: campaign.status,
      trustNote: campaign.trustNote,
      objective: campaign.objective,
      stageLabel: campaign.stageLabel,
      nextScheduled: campaign.nextScheduled,
      updatedLabel: formatUpdatedLabel(campaign.updatedAt),
      pendingApprovals: String(campaign.pendingApprovals),
      href: `/campaigns/${campaign.id}`,
      needsReview: campaign.pendingApprovals > 0 || campaign.status === 'in_review',
    })),
  };
}
