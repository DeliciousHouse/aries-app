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
    <section>
      <h1>Integrations</h1>
      <p>Route: /integrations</p>

      <div>
        <label htmlFor="integrations-filter">Filter</label>
        <select
          id="integrations-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as PlatformFilter)}
        >
          <option value="all">all</option>
          <option value="connected">connected</option>
          <option value="not_connected">not_connected</option>
          <option value="attention_required">attention_required</option>
        </select>

        <label htmlFor="integrations-sort">Sort</label>
        <select
          id="integrations-sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as IntegrationsSort)}
        >
          <option value="display_name_asc">display_name_asc</option>
          <option value="display_name_desc">display_name_desc</option>
          <option value="connection_state">connection_state</option>
          <option value="health">health</option>
        </select>

        <label htmlFor="integrations-search">Search</label>
        <input
          id="integrations-search"
          value={search}
          onChange={(event) => setSearch(event.target.value.slice(0, 80))}
          placeholder="Search platform"
        />

        <button type="button" onClick={handleRefresh} disabled={pageState === 'refreshing'}>
          {pageState === 'refreshing' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <ul>
        <li>Total: {summary.total}</li>
        <li>Connected: {summary.connected}</li>
        <li>Not connected: {summary.not_connected}</li>
        <li>Attention required: {summary.attention_required}</li>
      </ul>

      {lastError ? (
        <div role="alert">
          {lastError.error.code}: {lastError.error.message}
        </div>
      ) : null}

      <div>
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

      <details>
        <summary>Contract response preview</summary>
        <pre>{JSON.stringify(contractResponse, null, 2)}</pre>
      </details>
    </section>
  );
}
