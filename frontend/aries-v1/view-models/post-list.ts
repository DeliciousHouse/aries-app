import type { RuntimePostListItem } from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';
import { failedJobLabel, isFailedExecutionState } from '@/frontend/aries-v1/view-models/execution-state';

export interface SocialContentListViewModel {
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  items: Array<{
    id: string;
    name: string;
    summary: string;
    status: RuntimePostListItem['status'];
    trustNote: string;
    objective: string;
    dateRange: string;
    nextScheduled: string;
    pendingApprovals: string;
    stageLabel: string;
    updatedLabel: string;
    href: string;
    needsApproval: boolean;
    failed: boolean;
    failureLabel: string | null;
    actionLabel: string | null;
  }>;
}

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

export function createSocialContentListViewModel(campaigns: RuntimePostListItem[]): SocialContentListViewModel {
  const liveCount = campaigns.filter((campaign) => campaign.status === 'live').length;
  const reviewCount = campaigns.filter(
    (campaign) => campaign.status === 'in_review' || campaign.pendingApprovals > 0,
  ).length;
  const scheduledCount = campaigns.filter((campaign) => campaign.status === 'scheduled').length;

  return {
    hero: {
      eyebrow: 'Social content',
      title: 'Every post in one place',
      description:
        'Review the current state of each post, see what is blocked on approval, and open the exact workspace that needs attention.',
      metrics: [
        {
          label: 'Total posts',
          value: String(campaigns.length),
          detail:
            campaigns.length > 0 ? 'All runtime-backed posts are shown here.' : 'Create the first post to populate this view.',
        },
        {
          label: 'Live now',
          value: String(liveCount),
          detail:
            liveCount > 0 ? 'These posts have real runtime activity.' : 'No posts are currently live.',
          tone: liveCount > 0 ? 'good' : 'default',
        },
        {
          label: 'Need review',
          value: String(reviewCount),
          detail:
            reviewCount > 0 ? 'These posts are paused on approval or review.' : 'No posts are currently waiting on review.',
          tone: reviewCount > 0 ? 'watch' : 'good',
        },
        {
          label: 'Scheduled',
          value: String(scheduledCount),
          detail:
            scheduledCount > 0 ? 'Scheduled posts are ready for their publish windows.' : 'Nothing is scheduled yet.',
        },
      ],
    },
    items: campaigns.map((campaign) => {
      const failed = isFailedExecutionState(campaign.executionState);
      return {
        id: campaign.id,
        name: campaign.name,
        summary: campaign.summary,
        status: campaign.status,
        trustNote: campaign.trustNote,
        objective: campaign.objective,
        dateRange: campaign.dateRange,
        nextScheduled: campaign.nextScheduled,
        pendingApprovals: String(campaign.pendingApprovals),
        stageLabel: campaign.stageLabel,
        updatedLabel: formatUpdatedLabel(campaign.updatedAt),
        href: `/dashboard/social-content/${campaign.id}`,
        needsApproval: campaign.pendingApprovals > 0 || campaign.status === 'in_review',
        failed,
        failureLabel: failed ? failedJobLabel(campaign.stageLabel) : null,
        actionLabel: failed ? 'View failure details' : null,
      };
    }),
  };
}
