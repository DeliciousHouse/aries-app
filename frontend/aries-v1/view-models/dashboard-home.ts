import type { IntegrationCard } from '@/lib/api/integrations';
import type {
  AriesCampaignStatus,
  AriesChannelConnection,
  AriesItemStatus,
  BusinessProfileView,
  RuntimeCampaignListItem,
  RuntimeReviewItem,
} from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';

type DashboardHomePreviewItem = {
  id: string;
  title: string;
  meta: string;
  status: AriesCampaignStatus | AriesItemStatus;
  href: string;
};

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
    status: AriesCampaignStatus | AriesItemStatus;
    objective: string;
    stageLabel: string;
    nextScheduled: string;
    pendingApprovals: string;
    trustNote: string;
    href: string;
  } | null;
  publish: {
    count: number;
    pausedCount: number;
    title: string;
    detail: string;
    href: string;
    label: string;
    items: Array<{
      id: string;
      title: string;
      meta: string;
      status: AriesItemStatus;
      href: string;
    }>;
  };
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
      status: AriesCampaignStatus | AriesItemStatus;
      href: string;
      updatedLabel: string;
    }>;
  };
  workingNow: {
    mode: 'results' | 'publish' | 'waiting';
    title: string;
    summary: string;
    href: string;
    label: string;
    items: DashboardHomePreviewItem[];
  };
  channels: {
    connectedCount: number;
    totalCount: number;
    attentionCount: number;
    items: AriesChannelConnection[];
  };
}

const DASHBOARD_POSTS_HREF = '/dashboard/posts';
const DASHBOARD_RESULTS_HREF = '/dashboard/results';

function isScheduledValue(value: string): boolean {
  return !value.startsWith('Nothing') && !value.startsWith('Waiting');
}

function campaignHref(campaignId: string): string {
  return `/dashboard/campaigns/${campaignId}`;
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
        ? 'Connected and ready for publishing.'
        : card.connection_state === 'reauth_required'
          ? 'Needs reconnection before publishing can continue.'
          : card.connection_state === 'connection_error'
            ? card.error?.message || 'Channel setup needs attention before publishing can continue.'
            : card.connection_state === 'disabled'
              ? card.error?.message || 'Publishing is not ready yet.'
              : 'Not connected yet.',
  };
}

function readyToPublishCountFor(campaign: RuntimeCampaignListItem): number {
  return campaign.counts.readyToPublish + campaign.counts.pausedMetaAds;
}

function isLiveCampaign(campaign: RuntimeCampaignListItem): boolean {
  return campaign.status === 'live' || campaign.dashboardStatus === 'live';
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
      href: '/dashboard/campaigns/new',
      label: 'New Campaign',
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

  const readyCampaign = campaigns.find((campaign) => readyToPublishCountFor(campaign) > 0);
  if (readyCampaign) {
    const readyCount = readyToPublishCountFor(readyCampaign);
    return {
      title: 'Review what is ready to publish',
      summary: `${readyCount} publish-ready item${readyCount === 1 ? '' : 's'} are available now.`,
      href: DASHBOARD_POSTS_HREF,
      label: 'Open posts',
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
    href: campaignHref(active.id),
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
  const readyToPublishCount = args.campaigns.reduce((total, campaign) => total + readyToPublishCountFor(campaign), 0);
  const pausedCount = args.campaigns.reduce((total, campaign) => total + campaign.counts.pausedMetaAds, 0);
  const liveCampaigns = args.campaigns.filter(isLiveCampaign);
  const publishPreviewItems = args.campaigns
    .flatMap((campaign) =>
      campaign.dashboard.publishItems
        .filter((item) => item.status === 'ready_to_publish' || item.status === 'published_to_meta_paused')
        .map((item) => ({
          id: item.id,
          title: item.title,
          meta: `${item.campaignName} · ${item.platformLabel}`,
          status: item.status,
          href: DASHBOARD_POSTS_HREF,
        })),
    )
    .slice(0, 3);
  const resultItems = liveCampaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    summary:
      campaign.pendingApprovals > 0
        ? 'This campaign is live, but follow-up approvals are still queued.'
        : 'Live activity is present, so results can be reviewed directly from current runtime signals.',
    status: campaign.dashboardStatus === 'live' ? campaign.dashboardStatus : campaign.status,
    href: campaignHref(campaign.id),
    updatedLabel: formatUpdatedLabel(campaign.updatedAt),
  }));
  const workingNow: DashboardHomeViewModel['workingNow'] =
    resultItems.length > 0
      ? {
          mode: 'results',
          title: 'Live campaigns are sending result signal.',
          summary:
            'Aries is already seeing live campaign activity. Open the results surface for the operational mix, schedule readiness, and trust notes.',
          href: DASHBOARD_RESULTS_HREF,
          label: 'Open results',
          items: resultItems.map((item) => ({
            id: item.id,
            title: item.name,
            meta: item.updatedLabel,
            status: item.status,
            href: item.href,
          })),
        }
      : readyToPublishCount > 0
        ? {
            mode: 'publish',
            title: 'Launch-ready work is waiting for activation.',
            summary:
              'Nothing is live yet, but publish-ready items are already staged in the runtime. Open posts to review assets, publish-review entries, and paused Meta ads.',
            href: DASHBOARD_POSTS_HREF,
            label: 'Open posts',
            items: publishPreviewItems,
          }
        : {
            mode: 'waiting',
            title: 'Results will populate after launch.',
            summary:
              activeCampaign !== null
                ? 'Aries will summarize launch momentum and next actions here as soon as a campaign is live.'
                : 'Create a campaign and Aries will start grounding this surface in live runtime data.',
            href: activeCampaign !== null ? campaignHref(activeCampaign.id) : '/dashboard/campaigns/new',
            label: activeCampaign !== null ? 'Open campaign' : 'Create campaign',
            items: [],
          };

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
          label: 'Ready to publish',
          value: String(readyToPublishCount),
          detail:
            readyToPublishCount > 0
              ? `${readyToPublishCount} item${readyToPublishCount === 1 ? '' : 's'} are staged for launch now.`
              : 'New ready items will appear as soon as they are generated.',
          tone: readyToPublishCount > 0 ? 'good' : 'default',
        },
        {
          label: 'Connected channels',
          value: args.integrationsPending ? '...' : String(connectedCount),
          detail: args.integrationsPending
            ? 'Loading channel health.'
            : channelItems.length > 0
              ? `${channelItems.length} total publishing surfaces configured.`
              : 'No channels connected yet.',
          tone: args.integrationsPending ? 'default' : connectedCount > 0 ? 'good' : 'watch',
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
          : connectedCount === 0
            ? 'Publishing is not ready yet because no channels are connected.'
            : attentionCount > 0
            ? `${attentionCount} channel${attentionCount === 1 ? '' : 's'} need attention.`
            : `${connectedCount} channel${connectedCount === 1 ? '' : 's'} connected and ready to publish.`,
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
            status: activeCampaign.dashboardStatus,
            objective: activeCampaign.objective,
            stageLabel: activeCampaign.stageLabel,
            nextScheduled: activeCampaign.nextScheduled,
            pendingApprovals: String(activeCampaign.pendingApprovals),
            trustNote: activeCampaign.trustNote,
            href: campaignHref(activeCampaign.id),
          },
    publish: {
      count: readyToPublishCount,
      pausedCount,
      title:
        readyToPublishCount > 0
          ? `${readyToPublishCount} item${readyToPublishCount === 1 ? '' : 's'} ready to publish`
          : 'Nothing is ready to publish yet',
      detail:
        readyToPublishCount > 0
          ? pausedCount > 0
            ? `${pausedCount} Meta ad${pausedCount === 1 ? '' : 's'} are already created and paused for activation.`
            : 'Creative outputs and publish-review items are already staged in the runtime.'
          : 'Images, scripts, landing pages, and paused platform ads will appear here as soon as they are ready.',
      href: DASHBOARD_POSTS_HREF,
      label: 'Open posts',
      items: publishPreviewItems,
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
            href: campaignHref(activeCampaign.id),
          }
        : {
            title: 'Nothing scheduled yet',
            detail: 'Approved work will appear here once a campaign is ready to place on the calendar.',
            href: null,
          },
    results: {
      items: resultItems,
    },
    workingNow,
    channels: {
      connectedCount,
      totalCount: channelItems.length,
      attentionCount,
      items: channelItems,
    },
  };
}
