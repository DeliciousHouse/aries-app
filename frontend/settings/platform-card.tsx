"use client";

import type {
  IntegrationCard as PlatformIntegrationCardData,
  IntegrationCardAction,
  IntegrationConnectionState,
  IntegrationHealth,
  IntegrationPlatform as PlatformKey,
} from '@/lib/api/integrations';

export type { IntegrationCardAction, IntegrationHealth, PlatformIntegrationCardData, PlatformKey };

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
    <article className="glass-card" data-platform={card.platform} style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-4)' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
        <div className="feature-icon" style={{ flexShrink: 0, width: 40, height: 40, margin: 0 }}>
          {/* Simple initial fallback for icon */}
          <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'bold' }}>
            {card.display_name.charAt(0)}
          </span>
        </div>
        <div>
          <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 'var(--space-1)' }}>{card.display_name}</h3>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-secondary)', lineHeight: 1.4, margin: 0 }}>{card.description}</p>
        </div>
      </header>

      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4) 0', borderTop: '1px solid var(--aries-glass-border)', borderBottom: '1px solid var(--aries-glass-border)' }}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
          <span className="section-label" style={{ 
            margin: 0, 
            fontSize: '10px',
            backgroundColor: card.connection_state === 'connected' ? 'rgba(52, 211, 153, 0.1)' : card.connection_state.includes('error') ? 'rgba(248, 113, 113, 0.1)' : 'rgba(255, 255, 255, 0.05)',
            borderColor: card.connection_state === 'connected' ? 'rgba(52, 211, 153, 0.25)' : card.connection_state.includes('error') ? 'rgba(248, 113, 113, 0.25)' : 'var(--aries-glass-border)',
            color: card.connection_state === 'connected' ? 'var(--aries-success)' : card.connection_state.includes('error') ? 'var(--aries-error)' : 'var(--aries-text-secondary)'
          }}>
            {renderConnectionState(card.connection_state)}
          </span>
        </div>

        {card.connected_account && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account</span>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{card.connected_account.account_label}</span>
          </div>
        )}

        {card.last_synced_at && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last Sync</span>
            <span style={{ fontSize: 'var(--text-xs)' }}>
              {new Date(card.last_synced_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        )}

        {(card.connection_state === 'connected' || card.connection_state === 'reauth_required') && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Token Expiry</span>
            <span style={{ fontSize: 'var(--text-xs)' }}>
              {card.expires_at
                ? new Date(card.expires_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })
                : 'Unknown'}
            </span>
          </div>
        )}
      </div>

      {card.error && (
        <div className="alert alert-error" style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--text-xs)' }}>
          <svg style={{ flexShrink: 0 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          <div>
            <div style={{ fontWeight: 600 }}>{card.error.message}</div>
            {card.error.retry_after_seconds && <div>Retry after {card.error.retry_after_seconds}s</div>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'auto' }}>
        {card.available_actions.map((action) => {
          const isBusy = busyAction === action;
          
          // Determine button style based on action type
          let btnClass = "btn btn-sm btn-secondary";
          if (action === 'connect' || action === 'reconnect') btnClass = "btn btn-sm btn-primary";
          
          return (
            <button
              key={`${card.platform}-${action}`}
              type="button"
              className={btnClass}
              style={{ flex: action === 'connect' || action === 'reconnect' ? '1 1 100%' : '1 1 auto', justifyContent: 'center' }}
              onClick={() => onAction?.(action, card.platform)}
              disabled={isBusy}
            >
              {isBusy && <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2, marginRight: 'var(--space-2)' }}></div>}
              {actionLabel[action]}
            </button>
          );
        })}
      </div>
    </article>
  );
}

export default PlatformCard;
