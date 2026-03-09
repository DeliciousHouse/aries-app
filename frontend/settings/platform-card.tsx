"use client";

export type PlatformKey =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'x'
  | 'youtube'
  | 'reddit'
  | 'tiktok';

export type IntegrationConnectionState =
  | 'not_connected'
  | 'connection_pending'
  | 'connected'
  | 'connection_error'
  | 'reauth_required'
  | 'disabled';

export type IntegrationHealth = 'unknown' | 'healthy' | 'degraded' | 'error';

export type IntegrationCardAction =
  | 'connect'
  | 'reconnect'
  | 'disconnect'
  | 'sync_now'
  | 'view_permissions';

export type IntegrationErrorCode =
  | 'invalid_platform'
  | 'provider_unavailable'
  | 'auth_denied'
  | 'token_expired'
  | 'rate_limited'
  | 'validation_failed'
  | 'unknown';

export interface IntegrationPermission {
  permission: string;
  granted: boolean;
}

export interface ConnectedAccount {
  account_id: string;
  account_label: string;
  avatar_url?: string;
}

export interface IntegrationCardError {
  code: IntegrationErrorCode;
  message: string;
  retry_after_seconds?: number;
}

export interface PlatformIntegrationCardData {
  platform: PlatformKey;
  display_name: string;
  description: string;
  connection_state: IntegrationConnectionState;
  health: IntegrationHealth;
  connected_account?: ConnectedAccount;
  available_actions: IntegrationCardAction[];
  last_synced_at: string | null;
  permissions: IntegrationPermission[];
  error?: IntegrationCardError;
}

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
    <article data-platform={card.platform}>
      <header>
        <h3>{card.display_name}</h3>
        <p>{card.description}</p>
      </header>

      <dl>
        <dt>Connection</dt>
        <dd>{renderConnectionState(card.connection_state)}</dd>

        <dt>Health</dt>
        <dd>{renderHealth(card.health)}</dd>

        <dt>Last synced</dt>
        <dd>{card.last_synced_at ?? 'Never'}</dd>
      </dl>

      {card.connected_account ? (
        <p>
          Account: <strong>{card.connected_account.account_label}</strong> ({card.connected_account.account_id})
        </p>
      ) : null}

      {card.error ? (
        <div role="alert">
          Error: {card.error.code} · {card.error.message}
          {card.error.retry_after_seconds ? ` (retry after ${card.error.retry_after_seconds}s)` : ''}
        </div>
      ) : null}

      <div>
        {card.available_actions.map((action) => {
          const isBusy = busyAction === action;

          return (
            <button
              key={`${card.platform}-${action}`}
              type="button"
              onClick={() => onAction?.(action, card.platform)}
              disabled={isBusy}
            >
              {isBusy ? `${actionLabel[action]}…` : actionLabel[action]}
            </button>
          );
        })}
      </div>

      <details>
        <summary>Permissions ({card.permissions.length})</summary>
        <ul>
          {card.permissions.map((permission) => (
            <li key={`${card.platform}-${permission.permission}`}>
              {permission.permission}: {permission.granted ? 'granted' : 'not granted'}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export default PlatformCard;
