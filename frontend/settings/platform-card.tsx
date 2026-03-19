"use client";

import type {
  IntegrationCard as PlatformIntegrationCardData,
  IntegrationCardAction,
  IntegrationHealth,
  IntegrationPlatform as PlatformKey,
} from '@/lib/api/integrations';

export type { IntegrationCardAction, IntegrationHealth, PlatformIntegrationCardData, PlatformKey };
import { AriesMark } from '@/frontend/donor/ui';
import StatusBadge from '@/frontend/components/status-badge';

export interface PlatformCardProps {
  card: PlatformIntegrationCardData;
  onAction?: (action: IntegrationCardAction, platform: PlatformKey) => Promise<void> | void;
  busyAction?: IntegrationCardAction | null;
}

const actionLabel: Record<IntegrationCardAction, string> = {
  connect: 'Connect',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  sync_now: 'Sync now',
  view_permissions: 'View permissions'
};

function renderHealth(health: IntegrationHealth): string {
  switch (health) {
    case 'unknown':
      return 'Unknown';
    case 'healthy':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'error':
      return 'Error';
    default:
      return health;
  }
}

export function PlatformCard({ card, onAction, busyAction = null }: PlatformCardProps): JSX.Element {
  return (
    <div data-platform={card.platform} className="glass rounded-[2rem] p-6 h-full">
      <div className="grid gap-5 h-full">
        <header className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <span className="font-bold text-lg">{card.display_name.charAt(0)}</span>
          </div>
          <div>
            <h3 className="text-2xl font-bold">{card.display_name}</h3>
            <p className="text-white/55 mt-2 text-sm leading-relaxed">{card.description}</p>
          </div>
        </header>

        <div className="space-y-3">
          <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
            <strong className="text-sm">Status</strong>
            <StatusBadge
              status={
                card.connection_state === 'connected'
                  ? 'completed'
                  : card.connection_state === 'reauth_required'
                    ? 'required'
                    : card.connection_state === 'connection_error'
                      ? 'error'
                      : 'accepted'
              }
            />
          </div>

          {card.connected_account ? (
            <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
              <strong className="text-sm">Account</strong>
              <span className="text-sm text-white/70">{card.connected_account.account_label}</span>
            </div>
          ) : null}

          <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
            <strong className="text-sm">Health</strong>
            <span className="text-sm text-white/70">{renderHealth(card.health)}</span>
          </div>

          {card.last_synced_at ? (
            <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
              <strong className="text-sm">Last sync</strong>
              <span className="text-sm text-white/70">
                {new Date(card.last_synced_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
          ) : null}

          {(card.connection_state === 'connected' || card.connection_state === 'reauth_required') ? (
            <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
              <strong className="text-sm">Token expiry</strong>
              <span className="text-sm text-white/70">
                {card.expires_at
                  ? new Date(card.expires_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'Unknown'}
              </span>
            </div>
          ) : null}
        </div>

        {card.error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
            <div className="font-semibold">{card.error.message}</div>
            {card.error.retry_after_seconds ? <div className="text-sm mt-1">Retry after {card.error.retry_after_seconds}s</div> : null}
          </div>
        ) : null}

        <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4 flex items-center gap-3">
          <AriesMark sizeClassName="w-8 h-8" />
          <div>
            <div className="text-sm font-semibold">Aries OAuth handoff</div>
            <div className="text-xs text-white/55">
              Uses the internal Aries callback namespace for {card.display_name}.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 mt-auto">
          {card.available_actions.map((action) => {
            const isBusy = busyAction === action;
            const className =
              action === 'connect' || action === 'reconnect'
                ? 'bg-gradient-to-r from-primary to-secondary text-white shadow-xl shadow-primary/20'
                : 'bg-white/5 border border-white/10 text-white hover:bg-white/10';

            return (
              <button
                key={`${card.platform}-${action}`}
                type="button"
                className={`px-5 py-3 rounded-full font-semibold transition-all ${className}`}
                style={{ flex: action === 'connect' || action === 'reconnect' ? '1 1 100%' : '1 1 auto' }}
                onClick={() => onAction?.(action, card.platform)}
                disabled={isBusy}
              >
                {isBusy ? 'Working…' : actionLabel[action]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default PlatformCard;
