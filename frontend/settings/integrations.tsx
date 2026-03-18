"use client";

import { useMemo, useState } from 'react';

import { useIntegrations } from '@/hooks/use-integrations';
import {
  type GetIntegrationsPageError,
  type GetIntegrationsPageResponse,
  type IntegrationCard,
  type IntegrationCardAction,
  type IntegrationHealth,
  type IntegrationsSort,
  type PlatformFilter,
} from '@/lib/api/integrations';
import PlatformCard from './platform-card';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import { SelectInput } from '@/components/redesign/primitives/select';

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

function applyFilter(cards: IntegrationCard[], filter: PlatformFilter): IntegrationCard[] {
  if (filter === 'all') return cards;
  if (filter === 'connected') return cards.filter((card) => card.connection_state === 'connected');
  if (filter === 'not_connected') return cards.filter((card) => card.connection_state === 'not_connected');
  return cards.filter((card) => ['connection_error', 'reauth_required'].includes(card.connection_state));
}

function applySort(cards: IntegrationCard[], sort: IntegrationsSort): IntegrationCard[] {
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

function getVisibleError(
  response: GetIntegrationsPageResponse | null,
  message: string | null
): GetIntegrationsPageError | null {
  if (response?.status === 'error') {
    return response;
  }

  if (!message) {
    return null;
  }

  return {
    status: 'error',
    page_state: 'error',
    error: {
      code: 'provider_unavailable',
      message,
    },
  };
}

export default function IntegrationsScreen({ baseUrl = '' }: IntegrationsScreenProps): JSX.Element {
  const integrations = useIntegrations({ baseUrl });
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [sort, setSort] = useState<IntegrationsSort>('display_name_asc');
  const [search, setSearch] = useState('');
  
  const response = integrations.data;
  const cards = response?.status === 'ok' ? response.cards : [];
  const summary =
    response?.status === 'ok'
      ? response.summary
      : { total: 0, connected: 0, not_connected: 0, attention_required: 0 };
  const lastError = getVisibleError(response, integrations.error?.message ?? null);
  const pageState = integrations.status === 'loading'
    ? 'loading'
    : response?.status === 'error'
      ? 'error'
      : response?.page_state ?? 'ready';

  const visibleCards = useMemo<IntegrationCard[]>(() => {
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

  async function handleAction(action: IntegrationCardAction, platform: IntegrationCard['platform']): Promise<void> {
    const selectedCard = cards.find((card) => card.platform === platform);
    if (!selectedCard || action === 'view_permissions') {
      return;
    }

    await integrations.runAction(action, selectedCard);
  }

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <div className="rd-stat-grid">
        {[
          ['Total integrations', String(summary.total)],
          ['Connected', String(summary.connected)],
          ['Not connected', String(summary.not_connected)],
          ['Attention required', String(summary.attention_required)],
        ].map(([label, value]) => (
          <Card key={label}>
            <div style={{ display: 'grid', gap: '0.55rem' }}>
              <span className="rd-label">{label}</span>
              <strong style={{ fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>{value}</strong>
            </div>
          </Card>
        ))}
      </div>

      {lastError && (
        <div className="rd-alert rd-alert--danger">
          {lastError.error.message}
        </div>
      )}

      <Card>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="rd-field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="integrations-search" className="rd-label">Search platform</label>
          <div style={{ position: 'relative' }}>
            <svg style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--rd-text-subtle)', width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <TextInput
              id="integrations-search"
              style={{ paddingLeft: '36px' }}
              value={search}
              onChange={(event) => setSearch(event.target.value.slice(0, 80))}
              placeholder="e.g. Instagram"
            />
          </div>
        </div>

        <div className="rd-field" style={{ width: '180px' }}>
          <label htmlFor="integrations-filter" className="rd-label">Filter status</label>
          <SelectInput
            id="integrations-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as PlatformFilter)}
          >
            <option value="all">All Statuses</option>
            <option value="connected">Connected</option>
            <option value="not_connected">Not Connected</option>
            <option value="attention_required">Attention Required</option>
          </SelectInput>
        </div>

        <div className="rd-field" style={{ width: '180px' }}>
          <label htmlFor="integrations-sort" className="rd-label">Sort by</label>
          <SelectInput
            id="integrations-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as IntegrationsSort)}
          >
            <option value="display_name_asc">Name (A-Z)</option>
            <option value="display_name_desc">Name (Z-A)</option>
            <option value="connection_state">Status</option>
            <option value="health">Health</option>
          </SelectInput>
        </div>

        <Button type="button" variant="secondary" onClick={() => integrations.refresh()} disabled={pageState === 'refreshing'}>
          {pageState === 'refreshing' ? (
            <div className="rd-spinner" style={{ width: 14, height: 14, borderWidth: 2 }}></div>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          )}
          <span>Refresh List</span>
        </Button>
      </div>
      </Card>

      {(pageState === 'loading' || pageState === 'refreshing') && visibleCards.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-12)' }}>
          <div className="rd-spinner"></div>
        </div>
      ) : visibleCards.length === 0 ? (
        <Card>
          <p className="rd-section-description" style={{ marginBottom: 0, textAlign: 'center' }}>No platforms match your current filters.</p>
        </Card>
      ) : (
        <div className="rd-card-grid rd-card-grid--3">
          {visibleCards.map((card) => (
            <PlatformCard
              key={card.platform}
              card={card}
              onAction={handleAction}
              busyAction={
                integrations.busyAction && integrations.busyAction.startsWith(`${card.platform}:`)
                  ? (integrations.busyAction.split(':')[1] as IntegrationCardAction)
                  : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
