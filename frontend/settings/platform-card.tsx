"use client";

import type {
  IntegrationCard as PlatformIntegrationCardData,
  IntegrationCardAction,
  IntegrationConnectionState,
  IntegrationHealth,
  IntegrationPlatform as PlatformKey,
} from '@/lib/api/integrations';

export type { IntegrationCardAction, IntegrationHealth, PlatformIntegrationCardData, PlatformKey };
import { Card } from '@/components/redesign/primitives/card';

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

function renderConnectionState(state: IntegrationConnectionState): string {
  switch (state) {
    case 'not_connected':
      return 'Not connected';
    case 'connection_pending':
      return 'Connection pending';
    case 'connected':
      return 'Connected';
    case 'connection_error':
      return 'Connection error';
    case 'reauth_required':
      return 'Reauthorization required';
    case 'disabled':
      return 'Disabled';
    default:
      return state;
  }
}

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
    <Card data-platform={card.platform}>
      <div style={{ display: 'grid', gap: '1rem', height: '100%' }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
          <div className="rd-feature-icon" style={{ flexShrink: 0 }}>
            <span style={{ fontWeight: 800 }}>{card.display_name.charAt(0)}</span>
          </div>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.25rem' }}>{card.display_name}</h3>
            <p className="rd-section-description" style={{ marginTop: '0.35rem', fontSize: '0.92rem' }}>{card.description}</p>
          </div>
        </header>

        <div className="rd-summary-list">
          <div className="rd-summary-row">
            <strong>Status</strong>
            <span className="rd-badge">{renderConnectionState(card.connection_state)}</span>
          </div>

          {card.connected_account ? (
            <div className="rd-summary-row">
              <strong>Account</strong>
              <span>{card.connected_account.account_label}</span>
            </div>
          ) : null}

          <div className="rd-summary-row">
            <strong>Health</strong>
            <span>{renderHealth(card.health)}</span>
          </div>

          {card.last_synced_at ? (
            <div className="rd-summary-row">
              <strong>Last sync</strong>
              <span>
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
            <div className="rd-summary-row">
              <strong>Token expiry</strong>
              <span>
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
          <div className="rd-alert rd-alert--danger">
            <div>
              <div style={{ fontWeight: 700 }}>{card.error.message}</div>
              {card.error.retry_after_seconds ? <div>Retry after {card.error.retry_after_seconds}s</div> : null}
            </div>
          </div>
        ) : null}

        <div className="rd-inline-actions" style={{ marginTop: 'auto' }}>
          {card.available_actions.map((action) => {
            const isBusy = busyAction === action;
            const className = action === 'connect' || action === 'reconnect'
              ? 'rd-button rd-button--primary'
              : 'rd-button rd-button--secondary';

            return (
              <button
                key={`${card.platform}-${action}`}
                type="button"
                className={className}
                style={{ flex: action === 'connect' || action === 'reconnect' ? '1 1 100%' : '1 1 auto' }}
                onClick={() => onAction?.(action, card.platform)}
                disabled={isBusy}
              >
                {isBusy ? <span className="rd-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : null}
                {actionLabel[action]}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export default PlatformCard;
