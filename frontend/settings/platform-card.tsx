"use client";

import type { ComponentProps, JSX } from 'react';
import type {
  IntegrationCard as PlatformIntegrationCardData,
  IntegrationCardAction,
  IntegrationConnectionState,
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

function parseLastSyncDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// StatusBadge accepts the shared runtime status union; map every
// IntegrationConnectionState to a sensible badge so a new connection state
// (e.g. `connection_pending` during an in-flight OAuth) never falls through to
// the misleading `'accepted'` default. Returns the wider union expected by
// StatusBadge so callers do not have to cast.
export function connectionStateBadgeStatus(
  state: IntegrationConnectionState,
): ComponentProps<typeof StatusBadge>['status'] {
  switch (state) {
    case 'connected':
      return 'completed';
    case 'reauth_required':
      return 'required';
    case 'connection_error':
    case 'disabled':
      return 'error';
    case 'connection_pending':
      // In-flight OAuth handshake — show an "In progress" badge so the user
      // sees the call hasn't silently dropped on the floor.
      return 'in_progress';
    case 'not_connected':
      // Default empty state — the connect CTA already tells the user what to
      // do; a neutral 'unknown' badge avoids the "Accepted" lie.
      return 'unknown';
    default: {
      // Exhaustive: every value in IntegrationConnectionState is handled
      // above. If TypeScript ever widens the type without updating this
      // switch, `_exhaustive` becomes `IntegrationConnectionState` instead of
      // `never` and the compiler flags the gap.
      const _exhaustive: never = state;
      void _exhaustive;
      return 'unknown';
    }
  }
}

export function PlatformCard({ card, onAction, busyAction = null }: PlatformCardProps): JSX.Element {
  const usesAriesOauth = card.connection_state !== 'disabled';
  const showsSyncTelemetry =
    card.connection_state === 'connected' || card.connection_state === 'reauth_required';
  const lastSyncDate = parseLastSyncDate(card.last_synced_at);
  const lastSyncIsStale = lastSyncDate !== null && card.sync_state === 'stale';

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
            <StatusBadge status={connectionStateBadgeStatus(card.connection_state)} />
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

          {showsSyncTelemetry ? (
            <div className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
              <strong className="text-sm">Last sync</strong>
              <span className="flex items-center justify-end gap-2 text-sm text-white/70">
                {lastSyncDate
                  ? lastSyncDate.toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'Never synced'}
                {lastSyncIsStale ? (
                  <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-xs font-semibold text-amber-200">
                    Stale
                  </span>
                ) : null}
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
            <div className="text-sm font-semibold">{usesAriesOauth ? 'Aries OAuth handoff' : 'External configuration'}</div>
            <div className="text-xs text-white/55">
              {usesAriesOauth
                ? `Uses the internal Aries callback namespace for ${card.display_name}.`
                : `${card.display_name} is configured outside the Aries OAuth callback flow.`}
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
