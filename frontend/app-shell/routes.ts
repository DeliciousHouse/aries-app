export type AppRouteId =
  | 'home'
  | 'campaigns'
  | 'calendar'
  | 'results'
  | 'review'
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
    id: 'calendar',
    title: 'Calendar',
    href: '/dashboard/calendar',
    section: 'primary',
    description: 'Human-readable schedule visibility across campaigns and channels.'
  },
  {
    id: 'campaigns',
    title: 'Campaigns',
    href: '/dashboard/campaigns',
    section: 'primary',
    description: 'Campaign list and campaign workspace for plans, creative, schedule, and results.'
  },
  {
    id: 'results',
    title: 'Results',
    href: '/dashboard/results',
    section: 'primary',
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
