import type { IntegrationCard } from '@/lib/api/integrations';
import type {
  AriesPostStatus,
  AriesChannelConnection,
  AriesItemStatus,
  BusinessProfileView,
  RuntimePostListItem,
  RuntimeReviewItem,
} from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';
import {
  GENERATE_THIS_WEEK_LABEL,
  evaluateGenerateThisWeekGate,
  type GenerateThisWeekGate,
} from '@/frontend/aries-v1/generate-this-week';
import { failedJobLabel, isFailedExecutionState } from '@/frontend/aries-v1/view-models/execution-state';

type DashboardHomePreviewItem = {
  id: string;
  title: string;
  meta: string;
  status: AriesPostStatus | AriesItemStatus;
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
  activePost: {
    id: string;
    name: string;
    summary: string;
    status: AriesPostStatus | AriesItemStatus;
    objective: string;
    stageLabel: string;
    nextScheduled: string;
    pendingApprovals: string;
    trustNote: string;
    href: string;
    failed: boolean;
    failureLabel: string | null;
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
      status: AriesPostStatus;
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
      status: AriesPostStatus | AriesItemStatus;
      href: string;
      updatedLabel: string;
    }>;
  };
  workingNow: {
    mode: 'failure' | 'results' | 'publish' | 'waiting';
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
  generateThisWeek: {
    label: string;
    gate: GenerateThisWeekGate;
    enabled: boolean;
    inProgress: boolean;
    disabledReason: string | null;
  };
}

const DASHBOARD_POSTS_HREF = '/dashboard/posts';
const DASHBOARD_RESULTS_HREF = '/dashboard/results';

function isScheduledValue(value: string): boolean {
  return !value.startsWith('Nothing') && !value.startsWith('Waiting');
}

function postHref(postId: string): string {
  return `/dashboard/social-content/${postId}`;
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
    canDisconnect: card.available_actions.includes('disconnect'),
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

function readyToPublishCountFor(post: RuntimePostListItem): number {
  return post.counts.readyToPublish + post.counts.pausedMetaAds;
}

function isLivePost(post: RuntimePostListItem): boolean {
  return post.status === 'live' || post.dashboardStatus === 'live';
}

function nextActionFor(
  posts: RuntimePostListItem[],
  reviewCount: number,
): DashboardHomeViewModel['nextAction'] {
  if (posts.length === 0) {
    return {
      title: 'Create your first social content job',
      summary:
        'Aries will turn your business and goals into social content you can review before anything goes live.',
      href: '/dashboard/social-content/new',
      label: 'New social content job',
    };
  }

  const failedPost = posts[0];
  if (isFailedExecutionState(failedPost.executionState)) {
    const failureLabel = failedJobLabel(failedPost.stageLabel);
    return {
      title: failureLabel,
      summary: 'The latest social content job stopped before it could continue. Open the job to review the runtime failure and retry safely.',
      href: postHref(failedPost.id),
      label: 'View failure details',
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

  const readyPost = posts.find((post) => readyToPublishCountFor(post) > 0);
  if (readyPost) {
    const readyCount = readyToPublishCountFor(readyPost);
    return {
      title: 'Review what is ready to publish',
      summary: `${readyCount} publish-ready item${readyCount === 1 ? '' : 's'} are available now.`,
      href: DASHBOARD_POSTS_HREF,
      label: 'Open posts',
    };
  }

  const active = posts[0];
  if (active.approvalRequired && active.approvalActionHref) {
    return {
      title: 'Complete the current approval checkpoint',
      summary:
        'All visible review items are clear. Finalize the current social content checkpoint to continue the launch flow.',
      href: active.approvalActionHref,
      label: 'Open checkpoint',
    };
  }

  return {
    title: 'Open your latest social content job',
    summary:
      'Your workspace is ready. Check schedule, results, or prepare the next change from the active social content job.',
    href: postHref(active.id),
    label: 'Open social content job',
  };
}

export function createDashboardHomeViewModel(args: {
  posts: RuntimePostListItem[];
  reviews: RuntimeReviewItem[];
  profile: BusinessProfileView | null;
  integrationCards: IntegrationCard[];
  integrationsPending?: boolean;
}): DashboardHomeViewModel {
  const businessName = args.profile?.businessName || 'Your business';
  const activePost = args.posts[0] ?? null;
  const activePostFailed = activePost !== null && isFailedExecutionState(activePost.executionState);
  const activePostFailureLabel = activePostFailed ? failedJobLabel(activePost.stageLabel) : null;
  const channelItems = args.integrationCards.map(mapChannelConnection);
  const connectedCount = channelItems.filter((item) => item.health === 'connected').length;
  const attentionCount = channelItems.filter((item) => item.health === 'attention').length;
  const readyToPublishCount = args.posts.reduce((total, post) => total + readyToPublishCountFor(post), 0);
  const pausedCount = args.posts.reduce((total, post) => total + post.counts.pausedMetaAds, 0);
  const livePosts = args.posts.filter(isLivePost);
  const publishPreviewItems = args.posts
    .flatMap((post) =>
      post.dashboard.publishItems
        .filter((item) => item.status === 'ready_to_publish' || item.status === 'published_to_meta_paused')
        .map((item) => ({
          id: item.id,
          title: item.title,
          meta: `${item.postName} · ${item.platformLabel}`,
          status: item.status,
          href: DASHBOARD_POSTS_HREF,
        })),
    )
    .slice(0, 3);
  const resultItems = livePosts.map((post) => ({
    id: post.id,
    name: post.name,
    summary:
      post.pendingApprovals > 0
        ? 'This social content job is live, but follow-up approvals are still queued.'
        : 'Live activity is present, so results can be reviewed directly from current runtime signals.',
    status: post.dashboardStatus === 'live' ? post.dashboardStatus : post.status,
    href: postHref(post.id),
    updatedLabel: formatUpdatedLabel(post.updatedAt),
  }));
  const workingNow: DashboardHomeViewModel['workingNow'] =
    activePostFailed && activePost !== null
      ? {
          mode: 'failure',
          title: activePostFailureLabel || 'Job failed',
          summary:
            'The current social content job stopped and needs attention. Open its runtime details to see the failing stage before retrying.',
          href: postHref(activePost.id),
          label: 'View failure details',
          items: [],
        }
      : resultItems.length > 0
      ? {
          mode: 'results',
          title: 'Live social content jobs are sending result signal.',
          summary:
            'Aries is already seeing live social content activity. Open the results surface for the operational mix, schedule readiness, and trust notes.',
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
              activePost !== null
                ? 'Aries will summarize launch momentum and next actions here as soon as a social content job is live.'
                : 'Create a social content job and Aries will start grounding this surface in live runtime data.',
            href: activePost !== null ? postHref(activePost.id) : '/dashboard/social-content/new',
            label: activePost !== null ? 'Open social content job' : 'Create social content job',
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
          label: 'Social content jobs',
          value: String(args.posts.length),
          detail:
            activePost !== null
              ? activePostFailed
                ? `${activePost.name} stopped during ${activePost.stageLabel || 'execution'}.`
                : `${activePost.name} is the latest social content job in motion.`
              : 'Create your first social content job to begin.',
        },
        {
          label: 'Pending approvals',
          value: String(args.reviews.length),
          detail:
            args.reviews.length > 0
              ? 'The approval queue is waiting on a decision.'
              : activePostFailed
                ? 'The current job failed before another approval could be requested.'
                : 'Nothing needs a decision right now.',
          tone: args.reviews.length > 0 || activePostFailed ? 'watch' : 'good',
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
              ? 'Add missing business details so social content stays grounded.'
              : 'Business context is ready for social content and approvals.'
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
        value: args.reviews.length > 0 ? `${args.reviews.length} waiting` : activePostFailed ? 'Job failed' : 'Clear',
        detail:
          args.reviews.length > 0
            ? 'Resolve the review queue before launch can continue.'
            : activePostFailed
              ? 'The current job stopped before reaching another approval checkpoint. View failure details to continue.'
              : 'Nothing is paused on human approval right now.',
        tone: args.reviews.length > 0 || activePostFailed ? 'watch' : 'good',
      },
    ],
    nextAction: nextActionFor(args.posts, args.reviews.length),
    activePost:
      activePost === null
        ? null
        : {
            id: activePost.id,
            name: activePost.name,
            summary: activePost.summary,
            status: activePost.dashboardStatus,
            objective: activePost.objective,
            stageLabel: activePost.stageLabel,
            nextScheduled: activePost.nextScheduled,
            pendingApprovals: String(activePost.pendingApprovals),
            trustNote: activePost.trustNote,
            href: postHref(activePost.id),
            failed: activePostFailed,
            failureLabel: activePostFailureLabel,
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
      activePost !== null && isScheduledValue(activePost.nextScheduled)
        ? {
            title: activePost.nextScheduled,
            detail: `${activePost.name} is the next item on the schedule.`,
            href: postHref(activePost.id),
          }
        : {
            title: 'Nothing scheduled yet',
            detail: 'Approved work will appear here once a social content job is ready to place on the calendar.',
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
    generateThisWeek: {
      label: GENERATE_THIS_WEEK_LABEL,
      ...evaluateGenerateThisWeekGate({
        profile: args.profile,
        integrationCards: args.integrationCards,
        integrationsPending: args.integrationsPending,
        posts: args.posts.map((post) => ({
          status: post.status,
          dashboardStatus: post.dashboardStatus,
          approvalRequired: post.approvalRequired,
          executionState: post.executionState,
        })),
      }),
    },
  };
}
