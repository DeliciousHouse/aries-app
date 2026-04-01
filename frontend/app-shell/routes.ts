export type AppRouteId =
  | 'home'
  | 'newCampaign'
  | 'brandReview'
  | 'strategyReview'
  | 'creativeReview'
  | 'publishStatus'
  | 'campaigns'
  | 'posts'
  | 'calendar'
  | 'results'
  | 'review'
  | 'businessProfile'
  | 'channelIntegrations'
  | 'settings';

export interface AppRoute {
  id: AppRouteId;
  title: string;
  href: string;
  section: 'primary' | 'utility';
  description: string;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    id: 'home',
    title: 'Home',
    href: '/dashboard',
    section: 'primary',
    description: 'Executive command center for approvals, schedule, active campaigns, and results.'
  },
  {
    id: 'newCampaign',
    title: 'New Campaign',
    href: '/dashboard/campaigns/new',
    section: 'primary',
    description: 'Start a campaign with a persisted brief, uploads, and review-ready workflow state.'
  },
  {
    id: 'brandReview',
    title: 'Brand Review',
    href: '/dashboard/brand-review',
    section: 'primary',
    description: 'Review website analysis, brand bible output, design system, and uploaded brand assets.'
  },
  {
    id: 'strategyReview',
    title: 'Strategy Review',
    href: '/dashboard/strategy-review',
    section: 'primary',
    description: 'Review the campaign proposal, strategy packet, and revision history before production.'
  },
  {
    id: 'creativeReview',
    title: 'Creative Review',
    href: '/dashboard/creative-review',
    section: 'primary',
    description: 'Approve or request changes on every reviewable asset with full-preview access.'
  },
  {
    id: 'publishStatus',
    title: 'Publish / Status',
    href: '/dashboard/publish-status',
    section: 'primary',
    description: 'See workflow state, publish gating reasons, and what is truly ready to publish.'
  },
  {
    id: 'campaigns',
    title: 'Campaigns',
    href: '/dashboard/campaigns',
    section: 'utility',
    description: 'Campaign list and direct links into each campaign workspace.'
  },
  {
    id: 'posts',
    title: 'Posts',
    href: '/dashboard/posts',
    section: 'utility',
    description: 'Ready-to-publish inventory across images, scripts, landing pages, and paused platform ads.'
  },
  {
    id: 'calendar',
    title: 'Calendar',
    href: '/dashboard/calendar',
    section: 'utility',
    description: 'Human-readable schedule visibility across campaigns and channels.'
  },
  {
    id: 'results',
    title: 'Results',
    href: '/dashboard/results',
    section: 'utility',
    description: 'Business-readable reporting and recommended next actions.'
  },
  {
    id: 'review',
    title: 'Review Queue',
    href: '/review',
    section: 'utility',
    description: 'Approval queue for anything that could affect a launch.'
  },
  {
    id: 'businessProfile',
    title: 'Business Profile',
    href: '/dashboard/settings/business-profile',
    section: 'utility',
    description: 'Business context, website, goals, and launch approvals.'
  },
  {
    id: 'channelIntegrations',
    title: 'Channel Integrations',
    href: '/dashboard/settings/channel-integrations',
    section: 'utility',
    description: 'Connect publishing channels so Aries can schedule and monitor.'
  },
  {
    id: 'settings',
    title: 'Settings',
    href: '/dashboard/settings',
    section: 'utility',
    description: 'Business profile, channels, team approvals, and other account controls.'
  }
] as const;

export function getRouteById(routeId: AppRouteId): AppRoute {
  const route = APP_ROUTES.find((entry) => entry.id === routeId);
  if (!route) {
    throw new Error(`Unknown app route id: ${routeId}`);
  }
  return route;
}

export function getSectionRoutes(section: AppRoute['section']): AppRoute[] {
  return APP_ROUTES.filter((route) => route.section === section);
}
