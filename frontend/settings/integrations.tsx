"use client";

import { useMemo, useState } from 'react';
import PlatformCard, {
  type IntegrationCardAction,
  type IntegrationHealth,
  type PlatformIntegrationCardData,
  type PlatformKey
} from './platform-card';

type IntegrationsPageState = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
type PlatformFilter = 'all' | 'connected' | 'not_connected' | 'attention_required';
type IntegrationsSort = 'display_name_asc' | 'display_name_desc' | 'connection_state' | 'health';
type IntegrationsErrorCode = 'provider_unavailable' | 'rate_limited' | 'validation_failed' | 'unknown';

interface IntegrationsPageSummary {
  total: 7;
  connected: number;
  not_connected: number;
  attention_required: number;
}

interface IntegrationsPageError {
  code: IntegrationsErrorCode;
  message: string;
}

interface IntegrationsPageData {
  status: 'ok';
  page_state: 'ready' | 'refreshing';
  supported_platforms: PlatformKey[];
  cards: PlatformIntegrationCardData[];
  summary: IntegrationsPageSummary;
}

interface IntegrationsPageFailure {
  status: 'error';
  page_state: 'error';
  error: IntegrationsPageError;
}

const supportedPlatforms: PlatformKey[] = [
  'facebook',
  'instagram',
  'linkedin',
  'x',
  'youtube',
  'reddit',
  'tiktok'
];

const platformCardsSeed: PlatformIntegrationCardData[] = [
  {
    platform: 'facebook',
    display_name: 'Facebook',
    description: 'Connect a Facebook Page to publish and sync content.',
    connection_state: 'not_connected',
    health: 'unknown',
    available_actions: ['connect', 'view_permissions'],
    last_synced_at: null,
    permissions: [{ permission: 'pages_manage_posts', granted: false }]
  },
  {
    platform: 'instagram',
    display_name: 'Instagram',
    description: 'Connect an Instagram Business account for publishing.',
    connection_state: 'connected',
    health: 'healthy',
    connected_account: { account_id: 'ig_123', account_label: 'Acme IG' },
    available_actions: ['sync_now', 'disconnect', 'view_permissions'],
    last_synced_at: '2026-03-09T20:00:00Z',
    permissions: [{ permission: 'instagram_content_publish', granted: true }]
  },
  {
    platform: 'linkedin',
    display_name: 'LinkedIn',
    description: 'Connect LinkedIn to publish to your company page.',
    connection_state: 'reauth_required',
    health: 'degraded',
    available_actions: ['reconnect', 'view_permissions'],
    last_synced_at: '2026-03-08T18:00:00Z',
    permissions: [{ permission: 'w_member_social', granted: true }],
    error: { code: 'token_expired', message: 'Access token expired.' }
  },
  {
    platform: 'x',
    display_name: 'X',
    description: 'Connect X for post scheduling and analytics sync.',
    connection_state: 'connected',
    health: 'healthy',
    connected_account: { account_id: 'x_001', account_label: '@acme' },
    available_actions: ['sync_now', 'disconnect', 'view_permissions'],
    last_synced_at: '2026-03-09T19:50:00Z',
    permissions: [{ permission: 'tweet.write', granted: true }]
  },
  {
    platform: 'youtube',
    display_name: 'YouTube',
    description: 'Connect YouTube for channel publishing workflows.',
    connection_state: 'connection_pending',
    health: 'unknown',
    available_actions: ['connect', 'view_permissions'],
    last_synced_at: null,
    permissions: [{ permission: 'youtube.upload', granted: false }]
  },
  {
    platform: 'reddit',
    display_name: 'Reddit',
    description: 'Connect Reddit for community publishing automation.',
    connection_state: 'connection_error',
    health: 'error',
    available_actions: ['reconnect', 'view_permissions'],
    last_synced_at: null,
    permissions: [{ permission: 'submit', granted: false }],
    error: { code: 'provider_unavailable', message: 'Provider temporarily unavailable.', retry_after_seconds: 120 }
  },
  {
    platform: 'tiktok',
    display_name: 'TikTok',
    description: 'Connect TikTok Business for video publishing.',
    connection_state: 'disabled',
    health: 'unknown',
    available_actions: ['view_permissions'],
    last_synced_at: null,
    permissions: [{ permission: 'video.publish', granted: false }]
  }
];

function healthRank(health: IntegrationHealth): number {
  switch (health) {
    case 'error':
      return 0;
    case 'degraded':
      return 1;
    case 'healthy':
      return 2;
    case 'unknown':
      return 3;
    default:
      return 9;
  }
}

function buildSummary(cards: PlatformIntegrationCardData[]): IntegrationsPageSummary {
  const connected = cards.filter((card) => card.connection_state === 'connected').length;
  const notConnected = cards.filter((card) => card.connection_state === 'not_connected').length;
  const attentionRequired = cards.filter((card) =>
    ['connection_error', 'reauth_required'].includes(card.connection_state)
  ).length;

  return {
    total: 7,
    connected,
    not_connected: notConnected,
    attention_required: attentionRequired
  };
}

function applyFilter(cards: PlatformIntegrationCardData[], filter: PlatformFilter): PlatformIntegrationCardData[] {
  if (filter === 'all') return cards;
  if (filter === 'connected') return cards.filter((card) => card.connection_state === 'connected');
  if (filter === 'not_connected') return cards.filter((card) => card.connection_state === 'not_connected');
  return cards.filter((card) => ['connection_error', 'reauth_required'].includes(card.connection_state));
}

function applySort(cards: PlatformIntegrationCardData[], sort: IntegrationsSort): PlatformIntegrationCardData[] {
  const copy = [...cards];

  if (sort === 'display_name_asc') {
    return copy.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  if (sort === 'display_name_desc') {
    return copy.sort((a, b) => b.display_name.localeCompare(a.display_name));
  }

  if (sort === 'connection_state') {
    return copy.sort((a, b) => a.connection_state.localeCompare(b.connection_state));
  }

  return copy.sort((a, b) => healthRank(a.health) - healthRank(b.health));
}

export interface IntegrationsScreenProps {
  baseUrl?: string;
}

export default function IntegrationsScreen({ baseUrl = '' }: IntegrationsScreenProps): JSX.Element {
  const [pageState, setPageState] = useState<IntegrationsPageState>('ready');
  const [cards, setCards] = useState<PlatformIntegrationCardData[]>(platformCardsSeed);
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [sort, setSort] = useState<IntegrationsSort>('display_name_asc');
  const [search, setSearch] = useState('');
  const [lastError, setLastError] = useState<IntegrationsPageFailure | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const summary = useMemo(() => buildSummary(cards), [cards]);

  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = applyFilter(cards, filter);
    const searched =
      query.length === 0
        ? filtered
        : filtered.filter((card) => {
            return (
              card.display_name.toLowerCase().includes(query) ||
              card.description.toLowerCase().includes(query) ||
              card.platform.toLowerCase().includes(query)
            );
          });

    return applySort(searched, sort);
  }, [cards, filter, sort, search]);

  const contractResponse: IntegrationsPageData = {
    status: 'ok',
    page_state: pageState === 'refreshing' ? 'refreshing' : 'ready',
    supported_platforms: supportedPlatforms,
    cards,
    summary
  };

  async function handleRefresh(): Promise<void> {
    setPageState('refreshing');
    setLastError(null);

    try {
      const response = await fetch(`${baseUrl}/api/integrations`, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as IntegrationsPageData | IntegrationsPageFailure;
      if (body.status === 'error') {
        setLastError(body);
        setPageState('error');
        return;
      }

      setCards(body.cards);
      setPageState('ready');
    } catch {
      setLastError({
        status: 'error',
        page_state: 'error',
        error: {
          code: 'provider_unavailable',
          message: 'Unable to load integrations page data'
        }
      });
      setPageState('error');
    }
  }

  async function handleAction(action: IntegrationCardAction, platform: PlatformKey): Promise<void> {
    const actionKey = `${platform}:${action}`;
    setBusyKey(actionKey);

    try {
      if (action === 'connect' || action === 'reconnect') {
        await fetch(`${baseUrl}/api/integrations/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform, return_to: '/integrations' })
        });
      }

      if (action === 'disconnect') {
        await fetch(`${baseUrl}/api/integrations/disconnect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform, confirm: true })
        });
      }

      if (action === 'sync_now') {
        await fetch(`${baseUrl}/api/integrations/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform })
        });
      }
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="app-page">
      <div className="app-page-header">
        <h1 className="app-page-title">Platforms & Integrations</h1>
        <p className="app-page-desc">Connect and manage your social publishing channels.</p>
      </div>

      {/* Summary Metrics */}
      <div className="grid-4" style={{ marginBottom: 'var(--space-8)' }}>
        <div className="stat-card">
          <div className="stat-label">Total Integrations</div>
          <div className="stat-value">{summary.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Connected</div>
          <div className="stat-value" style={{ color: 'var(--aries-success)' }}>{summary.connected}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Not Connected</div>
          <div className="stat-value">{summary.not_connected}</div>
        </div>
        <div className="stat-card" style={{ borderColor: summary.attention_required > 0 ? 'var(--aries-warning)' : 'var(--aries-glass-border)' }}>
          <div className="stat-label" style={{ color: summary.attention_required > 0 ? 'var(--aries-warning)' : 'var(--aries-text-muted)' }}>Attention Required</div>
          <div className="stat-value" style={{ color: summary.attention_required > 0 ? 'var(--aries-warning)' : 'var(--aries-text-primary)' }}>{summary.attention_required}</div>
        </div>
      </div>

      {lastError && (
        <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          {lastError.error.message}
        </div>
      )}

      {/* Controls Container */}
      <div className="glass-card" style={{ padding: 'var(--space-4)', marginBottom: 'var(--space-6)', display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: '1 1 200px' }}>
          <label htmlFor="integrations-search" className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Search Platform</label>
          <div style={{ position: 'relative' }}>
            <svg style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--aries-text-muted)', width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input
              id="integrations-search"
              className="form-input"
              style={{ paddingLeft: '36px' }}
              value={search}
              onChange={(event) => setSearch(event.target.value.slice(0, 80))}
              placeholder="e.g. Instagram"
            />
          </div>
        </div>

        <div className="form-group" style={{ width: '180px' }}>
          <label htmlFor="integrations-filter" className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Filter Status</label>
          <select
            id="integrations-filter"
            className="form-select"
            value={filter}
            onChange={(event) => setFilter(event.target.value as PlatformFilter)}
          >
            <option value="all">All Statuses</option>
            <option value="connected">Connected</option>
            <option value="not_connected">Not Connected</option>
            <option value="attention_required">Attention Required</option>
          </select>
        </div>

        <div className="form-group" style={{ width: '180px' }}>
          <label htmlFor="integrations-sort" className="form-label" style={{ fontSize: 'var(--text-xs)' }}>Sort By</label>
          <select
            id="integrations-sort"
            className="form-select"
            value={sort}
            onChange={(event) => setSort(event.target.value as IntegrationsSort)}
          >
            <option value="display_name_asc">Name (A-Z)</option>
            <option value="display_name_desc">Name (Z-A)</option>
            <option value="connection_state">Status</option>
            <option value="health">Health</option>
          </select>
        </div>

        <button 
          type="button" 
          className="btn btn-secondary" 
          onClick={handleRefresh} 
          disabled={pageState === 'refreshing'}
        >
          {pageState === 'refreshing' ? (
            <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}></div>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          )}
          <span>Refresh List</span>
        </button>
      </div>

      {pageState === 'refreshing' && visibleCards.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-12)' }}>
          <div className="spinner"></div>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: 'var(--space-12)' }}>
          <p className="app-page-desc" style={{ marginBottom: 0 }}>No platforms match your current filters.</p>
        </div>
      ) : (
        <div className="grid-3">
          {visibleCards.map((card) => (
            <PlatformCard
              key={card.platform}
              card={card}
              onAction={handleAction}
              busyAction={
                busyKey && busyKey.startsWith(`${card.platform}:`)
                  ? (busyKey.split(':')[1] as IntegrationCardAction)
                  : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
