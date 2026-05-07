'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useIntegrations } from '@/hooks/use-integrations';
import { useBusinessProfile } from '@/hooks/use-business-profile';
import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';
import { useRuntimeReviews } from '@/hooks/use-runtime-reviews';
import type { IntegrationPlatform } from '@/lib/api/integrations';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { LoadingStateGrid } from './components';
import DashboardHomePresenter from './presenters/dashboard-home-presenter';
import { createDashboardHomeViewModel } from './view-models/dashboard-home';
import {
  customerSafeGenerateThisWeekError,
  submitGenerateThisWeek,
} from './generate-this-week';

export default function AriesHomeDashboard() {
  const router = useRouter();
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const reviews = useRuntimeReviews({ autoLoad: true });
  const profile = useBusinessProfile({ autoLoad: true });
  const integrations = useIntegrations({ autoLoad: true });
  const [generateState, setGenerateState] = useState<{
    submitting: boolean;
    errorMessage: string | null;
    jobStatusUrl: string | null;
  }>({ submitting: false, errorMessage: null, jobStatusUrl: null });

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

  const onGenerateThisWeek = useCallback(async () => {
    if (generateState.submitting || !model.generateThisWeek.enabled) {
      return;
    }
    setGenerateState({ submitting: true, errorMessage: null, jobStatusUrl: null });
    try {
      const result = await submitGenerateThisWeek();
      if (!result.ok) {
        setGenerateState({
          submitting: false,
          errorMessage: customerSafeGenerateThisWeekError(result.errorMessage),
          jobStatusUrl: null,
        });
        return;
      }
      const target =
        result.jobStatusUrl ??
        (result.jobId ? `/social-content/status?jobId=${encodeURIComponent(result.jobId)}` : null);
      if (!target) {
        setGenerateState({
          submitting: false,
          errorMessage: customerSafeGenerateThisWeekError(null),
          jobStatusUrl: null,
        });
        return;
      }
      setGenerateState({ submitting: false, errorMessage: null, jobStatusUrl: target });
      router.push(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : null;
      setGenerateState({
        submitting: false,
        errorMessage: customerSafeGenerateThisWeekError(message),
        jobStatusUrl: null,
      });
    }
  }, [generateState.submitting, model.generateThisWeek.enabled, router]);

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
      generateThisWeek={{
        submitting: generateState.submitting,
        errorMessage: generateState.errorMessage,
        jobStatusUrl: generateState.jobStatusUrl,
        onTrigger: onGenerateThisWeek,
      }}
    />
  );
}
