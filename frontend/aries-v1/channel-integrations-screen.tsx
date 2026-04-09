'use client';

import { useIntegrations } from '@/hooks/use-integrations';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesChannelIntegrationsScreen() {
  const integrations = useIntegrations({ autoLoad: true });
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];

  if (integrations.isLoading) {
    return <LoadingStateGrid />;
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Channels / Integrations" title="Where Aries can publish or monitor">
        {integrations.error ? (
          <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
            {customerSafeUiErrorMessage(integrations.error.message, 'Channel status is not available right now.')}
          </div>
        ) : integrationCards.length === 0 ? (
          <EmptyStatePanel
            compact
            title="No integrations yet"
            description="Connect channels so Aries can publish, schedule, and monitor launches."
          />
        ) : (
          <div className="space-y-3">
            {integrationCards.map((card) => (
              <div key={card.platform} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-white">{card.display_name}</p>
                    <p className="text-sm text-white/45">{card.description}</p>
                  </div>
                  <StatusChip
                    status={
                      card.connection_state === 'connected'
                        ? 'approved'
                        : card.connection_state === 'reauth_required'
                          ? 'changes_requested'
                          : 'draft'
                    }
                  >
                    {card.connection_state === 'connected'
                      ? 'Connected'
                      : card.connection_state === 'reauth_required'
                        ? 'Needs attention'
                        : card.connection_state === 'disabled'
                          ? 'Setup needed'
                          : 'Not connected'}
                  </StatusChip>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShellPanel>
    </div>
  );
}
