export type AppRouteId =
  | 'dashboard'
  | 'posts'
  | 'calendar'
  | 'platforms'
  | 'settings';

export interface AppRoute {
  id: AppRouteId;
  title: string;
  href: string;
  section: 'operator';
  description: string;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    href: '/dashboard',
    section: 'operator',
    description: 'Operator overview for queue health, publish velocity, and platform status.'
  },
  {
    id: 'posts',
    title: 'Posts',
    href: '/posts',
    section: 'operator',
    description: 'Operator guidance for campaign publishing through the stage-based marketing job flow.'
  },
  {
    id: 'calendar',
    title: 'Calendar',
    href: '/calendar',
    section: 'operator',
    description: 'Schedule visibility and sync control across connected channels.'
  },
  {
    id: 'platforms',
    title: 'Platforms',
    href: '/platforms',
    section: 'operator',
    description: 'Shared OAuth broker status and provider connection controls.'
  },
  {
    id: 'settings',
    title: 'Settings',
    href: '/settings',
    section: 'operator',
    description: 'Tenant, delivery, and platform defaults used by orchestration flows.'
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
