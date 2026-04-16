'use client';

import type { IntegrationCardAction } from '@/lib/api/integrations';
import { useIntegrations } from '@/hooks/use-integrations';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesChannelIntegrationsScreen() {
  const integrations = useIntegrations({ autoLoad: true });
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];

  async function handleIntegrationAction(
    action: 'connect' | 'reconnect' | 'disconnect',
    platform: string
  ) {
    const card = integrationCards.find((item) => item.platform === platform);
    if (!card) {
      return;
    }

    if (action === 'connect' || action === 'reconnect') {
      const oauthPage = new URL(`/oauth/connect/${platform}`, window.location.origin);
      oauthPage.searchParams.set('mode', action === 'reconnect' ? 'reconnect' : 'connect');
      if (card.connection_id) {
        oauthPage.searchParams.set('connection_id', card.connection_id);
      }
      window.location.assign(oauthPage.toString());
      return;
    }

    await integrations.runAction(action, card);
  }

  function renderPrimaryAction(card: (typeof integrationCards)[number]): {
    action: Extract<IntegrationCardAction, 'connect' | 'reconnect' | 'disconnect'>;
    label: string;
    className: string;
  } | null {
    if (card.connection_state === 'connected') {
      return {
        action: 'disconnect',
        label: integrations.busyAction === `${card.platform}:disconnect` ? 'Disconnecting…' : 'Disconnect',
        className:
          'inline-flex items-center gap-2 rounded-full border border-red-500/85 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/[0.06] hover:border-red-400 disabled:opacity-60',
      };
    }

    if (card.connection_state === 'reauth_required' || card.connection_state === 'connection_error') {
      return {
        action: 'reconnect',
        label: integrations.busyAction === `${card.platform}:reconnect` ? 'Reconnecting…' : 'Reconnect',
        className:
          'inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-300/20 disabled:opacity-60',
      };
    }

    return {
      action: 'connect',
      label: integrations.busyAction === `${card.platform}:connect` ? 'Connecting…' : 'Connect',
      className:
        'inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60',
    };
  }

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
              {integrationCards.map((card) => {
                const primaryAction = renderPrimaryAction(card);

                return (
                  <div key={card.platform} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">{card.display_name}</p>
                        <p className="text-sm text-white/45">{card.description}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
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
                        {primaryAction ? (
                          <button
                            type="button"
                            onClick={() => void handleIntegrationAction(primaryAction.action, card.platform)}
                            disabled={integrations.busyAction === `${card.platform}:${primaryAction.action}`}
                            className={primaryAction.className}
                          >
                            {primaryAction.label}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </ShellPanel>
    </div>
  );
}
