export type AppRouteId =
  | 'onboarding.start'
  | 'onboarding.status'
  | 'marketing.new-job'
  | 'marketing.job-status'
  | 'marketing.job-approve';

export interface AppRoute {
  id: AppRouteId;
  title: string;
  href: string;
  section: 'onboarding' | 'marketing';
  description: string;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    id: 'onboarding.start',
    title: 'Start',
    href: '/onboarding/start',
    section: 'onboarding',
    description: 'Submit onboarding start payload.'
  },
  {
    id: 'onboarding.status',
    title: 'Status',
    href: '/onboarding/status',
    section: 'onboarding',
    description: 'Check onboarding/provisioning validation states.'
  },
  {
    id: 'marketing.new-job',
    title: 'New Job',
    href: '/marketing/new-job',
    section: 'marketing',
    description: 'Create and start a marketing workflow job.'
  },
  {
    id: 'marketing.job-status',
    title: 'Job Status',
    href: '/marketing/job-status',
    section: 'marketing',
    description: 'Inspect stage and approval state for a job.'
  },
  {
    id: 'marketing.job-approve',
    title: 'Job Approve',
    href: '/marketing/job-approve',
    section: 'marketing',
    description: 'Approve stages and resume paused workflows.'
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
