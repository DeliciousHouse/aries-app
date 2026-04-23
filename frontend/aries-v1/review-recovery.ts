import type { ApiError } from '@/lib/api/types';

export type ReviewRecoveryState = {
  title: string;
  description: string;
  guidance: string;
  primaryAction: {
    label: string;
    href: string;
  };
  secondaryAction: {
    label: string;
    href: string;
  };
};

export function getReviewRecoveryState(error: ApiError | null): ReviewRecoveryState | null {
  if (error?.code !== 'review_not_in_current_workspace') {
    return null;
  }

  return {
    title: 'This review belongs to a different workspace',
    description:
      'The link resolved to a valid review item, but the workspace currently active for your account does not own it.',
    guidance:
      'Open your current queue or campaigns from here. If you expected another workspace, sign out and reopen the same link with the correct account.',
    primaryAction: {
      label: 'Open review queue',
      href: '/review',
    },
    secondaryAction: {
      label: 'Open campaigns',
      href: '/dashboard/campaigns',
    },
  };
}
