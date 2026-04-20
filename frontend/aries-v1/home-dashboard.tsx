'use client';

import { useMemo } from 'react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useBusinessProfile } from '@/hooks/use-business-profile';
import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';
import { useRuntimeReviews } from '@/hooks/use-runtime-reviews';
import type { IntegrationPlatform } from '@/lib/api/integrations';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { LoadingStateGrid } from './components';
import DashboardHomePresenter from './presenters/dashboard-home-presenter';
import { createDashboardHomeViewModel } from './view-models/dashboard-home';

export default function AriesHomeDashboard() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const reviews = useRuntimeReviews({ autoLoad: true });
  const profile = useBusinessProfile({ autoLoad: true });
  const integrations = useIntegrations({ autoLoad: true });

  // Review queue data is useful, but it should not block the dashboard shell.
  // A slow reviews fetch can happen when runtime review hydration needs to scan
  // large job payloads; keep the dashboard usable and let reviews hydrate later.
  const loading = campaigns.isLoading || profile.profile.isLoading;
  const loadError = campaigns.error || profile.profile.error;
  const campaignList = campaigns.data?.campaigns ?? [];
  const reviewList = reviews.data?.reviews ?? [];
  const profileData = profile.profile.data?.profile ?? null;
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const integrationsPending = integrations.isLoading;

  const model = useMemo(
    () =>
      createDashboardHomeViewModel({
        campaigns: campaignList,
        reviews: reviewList,
        profile: profileData,
        integrationCards,
        integrationsPending,
      }),
    [campaignList, integrationCards, integrationsPending, profileData, reviewList],
  );

  if (loading) {
    return <LoadingStateGrid />;
  }

  if (loadError) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(loadError.message, 'Dashboard data is not available right now.')}
      </div>
    );
  }

  return (
    <DashboardHomePresenter
      model={model}
      channelsState={integrations.isLoading ? 'loading' : integrations.error ? 'error' : 'ready'}
      channelsErrorMessage={customerSafeUiErrorMessage(
        integrations.error?.message ?? null,
        'Channel status is not available right now.',
      )}
      channelsBusyAction={integrations.busyAction}
      onChannelDisconnect={(channelId) =>
        void integrations.runAction('disconnect', { platform: channelId as IntegrationPlatform })
      }
    />
  );
}
