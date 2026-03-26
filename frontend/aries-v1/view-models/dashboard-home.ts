import type { IntegrationCard } from '@/lib/api/integrations';
import type {
  AriesCampaignStatus,
  AriesChannelConnection,
  BusinessProfileView,
  RuntimeCampaignListItem,
  RuntimeReviewItem,
} from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';

export interface DashboardHomeViewModel {
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  readiness: Array<{
    label: string;
    value: string;
    detail: string;
    tone: 'default' | 'good' | 'watch';
  }>;
  nextAction: {
    title: string;
    summary: string;
    href: string;
    label: string;
  };
  activeCampaign: {
    id: string;
    name: string;
    summary: string;
    status: AriesCampaignStatus;
    objective: string;
    stageLabel: string;
    nextScheduled: string;
    pendingApprovals: string;
    trustNote: string;
    href: string;
  } | null;
  reviews: {
    count: number;
    items: Array<{
      id: string;
      title: string;
      meta: string;
      status: AriesCampaignStatus;
      href: string;
    }>;
  };
  schedule: {
    title: string;
    detail: string;
    href: string | null;
  };
  results: {
    items: Array<{
      id: string;
      name: string;
      summary: string;
      status: AriesCampaignStatus;
      href: string;
      updatedLabel: string;
    }>;
  };
  channels: {
    connectedCount: number;
    totalCount: number;
    attentionCount: number;
    items: AriesChannelConnection[];
  };
}

function isScheduledValue(value: string): boolean {
  return !value.startsWith('Nothing') && !value.startsWith('Waiting');
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

function mapChannelConnection(card: IntegrationCard): AriesChannelConnection {
  const health =
    card.connection_state === 'connected'
      ? 'connected'
      : card.connection_state === 'reauth_required' || card.connection_state === 'connection_error'
        ? 'attention'
        : 'not_connected';

  return {
    id: card.platform,
    name: card.display_name,
    handle: card.connected_account?.account_label || card.platform,
    health,
    detail:
      card.connection_state === 'connected'
        ? 'Connected and ready for scheduling.'
        : card.connection_state === 'reauth_required'
          ? 'Needs reconnection before the next launch.'
          : card.connection_state === 'connection_error'
            ? card.error?.message || 'Connection needs attention before the next launch.'
            : 'Not connected yet.',
  };
}

function nextActionFor(
  campaigns: RuntimeCampaignListItem[],
  reviewCount: number,
): DashboardHomeViewModel['nextAction'] {
  if (campaigns.length === 0) {
    return {
      title: 'Create your first campaign',
      summary:
        'Aries will turn your business and goals into a campaign you can review before anything goes live.',
      href: '/onboarding/start',
      label: 'Create campaign',
    };
  }

  if (reviewCount > 0) {
    return {
      title: 'Review what is waiting',
      summary: `${reviewCount} item${reviewCount === 1 ? '' : 's'} need a decision before launch can continue.`,
      href: '/review',
      label: 'Open review queue',
    };
  }

  const active = campaigns[0];
  if (active.approvalRequired && active.approvalActionHref) {
    return {
      title: 'Complete the current approval checkpoint',
      summary:
        'All visible review items are clear. Finalize the current campaign checkpoint to continue the launch flow.',
      href: active.approvalActionHref,
      label: 'Open checkpoint',
    };
  }

  return {
    title: 'Open your latest campaign',
    summary:
      'Your workspace is ready. Check schedule, results, or prepare the next change from the active campaign.',
    href: `/campaigns/${active.id}`,
    label: 'Open campaign',
  };
}

export function createDashboardHomeViewModel(args: {
  campaigns: RuntimeCampaignListItem[];
  reviews: RuntimeReviewItem[];
  profile: BusinessProfileView | null;
  integrationCards: IntegrationCard[];
  integrationsPending?: boolean;
}): DashboardHomeViewModel {
  const businessName = args.profile?.businessName || 'Your business';
  const activeCampaign = args.campaigns[0] ?? null;
  const channelItems = args.integrationCards.map(mapChannelConnection);
  const connectedCount = channelItems.filter((item) => item.health === 'connected').length;
  const attentionCount = channelItems.filter((item) => item.health === 'attention').length;
  const liveCampaigns = args.campaigns.filter((campaign) => campaign.status === 'live');

  return {
    hero: {
      eyebrow: 'Dashboard',
      title: businessName,
      description:
        'Aries keeps the operating picture calm: what is live, what needs a decision, what is scheduled next, and where the workspace needs attention.',
      metrics: [
        {
          label: 'Campaigns',
          value: String(args.campaigns.length),
          detail:
            activeCampaign !== null
              ? `${activeCampaign.name} is the latest campaign in motion.`
              : 'Create your first campaign to begin.',
        },
        {
          label: 'Pending approvals',
          value: String(args.reviews.length),
          detail:
            args.reviews.length > 0
              ? 'The approval queue is waiting on a decision.'
              : 'Nothing needs a decision right now.',
          tone: args.reviews.length > 0 ? 'watch' : 'good',
        },
        {
          label: 'Connected channels',
          value: args.integrationsPending ? '...' : String(connectedCount),
          detail: args.integrationsPending
            ? 'Loading channel health.'
            : channelItems.length > 0
              ? `${channelItems.length} total publishing surfaces configured.`
              : 'No channels connected yet.',
          tone:
            args.integrationsPending || connectedCount > 0 ? 'good' : 'watch',
        },
        {
          label: 'Profile status',
          value: args.profile ? (args.profile.incomplete ? 'Needs setup' : 'Ready') : 'Unavailable',
          detail: args.profile
            ? args.profile.incomplete
              ? 'Add missing business details so campaigns stay grounded.'
              : 'Business context is ready for campaigns and approvals.'
            : 'Business profile data could not be loaded.',
          tone: args.profile ? (args.profile.incomplete ? 'watch' : 'good') : 'watch',
        },
      ],
    },
    readiness: [
      {
        label: 'Profile',
        value: args.profile ? (args.profile.incomplete ? 'Needs detail' : 'Ready') : 'Unavailable',
        detail: args.profile?.websiteUrl
          ? args.profile.websiteUrl
          : args.profile
            ? 'Add a website and business goal in Settings.'
            : 'Business profile data is currently unavailable.',
        tone: args.profile ? (args.profile.incomplete ? 'watch' : 'good') : 'watch',
      },
      {
        label: 'Channels',
        value: args.integrationsPending ? 'Loading' : `${connectedCount} ready`,
        detail: args.integrationsPending
          ? 'Checking publishing connections.'
          : attentionCount > 0
            ? `${attentionCount} channel${attentionCount === 1 ? '' : 's'} need attention.`
            : 'Publishing connections are healthy.',
        tone: args.integrationsPending ? 'default' : attentionCount > 0 ? 'watch' : 'good',
      },
      {
        label: 'Approvals',
        value: args.reviews.length > 0 ? `${args.reviews.length} waiting` : 'Clear',
        detail:
          args.reviews.length > 0
            ? 'Resolve the review queue before launch can continue.'
            : 'Nothing is paused on human approval right now.',
        tone: args.reviews.length > 0 ? 'watch' : 'good',
      },
    ],
    nextAction: nextActionFor(args.campaigns, args.reviews.length),
    activeCampaign:
      activeCampaign === null
        ? null
        : {
            id: activeCampaign.id,
            name: activeCampaign.name,
            summary: activeCampaign.summary,
            status: activeCampaign.status,
            objective: activeCampaign.objective,
            stageLabel: activeCampaign.stageLabel,
            nextScheduled: activeCampaign.nextScheduled,
            pendingApprovals: String(activeCampaign.pendingApprovals),
            trustNote: activeCampaign.trustNote,
            href: `/campaigns/${activeCampaign.id}`,
          },
    reviews: {
      count: args.reviews.length,
      items: args.reviews.slice(0, 3).map((item) => ({
        id: item.id,
        title: item.title,
        meta: `${item.channel} · ${item.placement} · ${item.scheduledFor}`,
        status: item.status,
        href: `/review/${item.id}`,
      })),
    },
    schedule:
      activeCampaign !== null && isScheduledValue(activeCampaign.nextScheduled)
        ? {
            title: activeCampaign.nextScheduled,
            detail: `${activeCampaign.name} is the next item on the schedule.`,
            href: `/campaigns/${activeCampaign.id}`,
          }
        : {
            title: 'Nothing scheduled yet',
            detail: 'Approved work will appear here once a campaign is ready to place on the calendar.',
            href: null,
          },
    results: {
      items: liveCampaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        summary:
          campaign.pendingApprovals > 0
            ? 'This campaign is live, but follow-up approvals are still queued.'
            : 'Live activity is present, so results can be reviewed without demo metrics.',
        status: campaign.status,
        href: `/campaigns/${campaign.id}`,
        updatedLabel: formatUpdatedLabel(campaign.updatedAt),
      })),
    },
    channels: {
      connectedCount,
      totalCount: channelItems.length,
      attentionCount,
      items: channelItems,
    },
  };
}
