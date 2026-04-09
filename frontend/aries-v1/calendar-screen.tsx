'use client';

import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';
import CalendarPresenter from '@/frontend/aries-v1/presenters/calendar-presenter';
import { createCalendarViewModel } from '@/frontend/aries-v1/view-models/calendar';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { LoadingStateGrid } from './components';

export default function AriesCalendarScreen() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const items = campaigns.data?.campaigns ?? [];

  if (campaigns.isLoading) {
    return <LoadingStateGrid />;
  }

  if (campaigns.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(campaigns.error.message, 'The calendar is not available right now.')}
      </div>
    );
  }

  return <CalendarPresenter model={createCalendarViewModel(items)} />;
}
