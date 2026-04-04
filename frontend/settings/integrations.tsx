"use client";

import { useMemo, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';

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
import { AriesMark } from '@/frontend/donor/ui';

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
  if (filter === 'not_connected') {
    return cards.filter((card) => card.connection_state === 'not_connected' || card.connection_state === 'disabled');
  }
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

    if (action === 'connect' || action === 'reconnect') {
      const oauthPage = new URL(`/oauth/connect/${platform}`, window.location.origin);
      oauthPage.searchParams.set('mode', action === 'reconnect' ? 'reconnect' : 'connect');
      if (selectedCard.connection_id) {
        oauthPage.searchParams.set('connection_id', selectedCard.connection_id);
      }
      window.location.assign(oauthPage.toString());
      return;
    }

    await integrations.runAction(action, selectedCard);
  }

  return (
    <div className="space-y-6">
      <div className="glass rounded-[2.5rem] p-8">
        <div className="flex justify-between gap-6 items-start flex-wrap">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-4">
              <AriesMark sizeClassName="w-11 h-11" />
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">OAuth broker</p>
            </div>
            <h2 className="text-3xl font-bold mb-3">
              Connect providers with the same Aries handoff flow across the product
            </h2>
            <p className="text-white/60">
              Facebook, LinkedIn, X, YouTube, TikTok, and Reddit use the Aries OAuth callback flow. Instagram stays on env-backed configuration.
            </p>
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 min-w-[260px]">
            <div className="space-y-3 text-sm text-white/65">
              <div className="flex justify-between gap-4">
                <strong className="text-white">Callback namespace</strong>
                <code>/api/auth/oauth/:provider/callback</code>
              </div>
              <div className="flex justify-between gap-4">
                <strong className="text-white">Connect experience</strong>
                <span>Branded Aries interstitial</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        {[
          ['Total integrations', String(summary.total)],
          ['Connected', String(summary.connected)],
          ['Not connected', String(summary.not_connected)],
          ['Attention required', String(summary.attention_required)],
        ].map(([label, value]) => (
          <div key={label} className="glass rounded-[2rem] p-6">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</span>
            <strong className="block text-4xl font-bold mt-3">{value}</strong>
          </div>
        ))}
      </div>

      {lastError ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          {lastError.error.message}
        </div>
      ) : null}

      <div className="glass rounded-[2.5rem] p-8">
        <div className="flex gap-4 flex-wrap items-end">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="integrations-search" className="block text-xs uppercase tracking-[0.22em] text-white/35 mb-2">
              Search platform
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/35" />
              <input
                id="integrations-search"
                className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                value={search}
                onChange={(event) => setSearch(event.target.value.slice(0, 80))}
                placeholder="e.g. Instagram"
              />
            </div>
          </div>

          <div className="w-full md:w-[190px]">
            <label htmlFor="integrations-filter" className="block text-xs uppercase tracking-[0.22em] text-white/35 mb-2">
              Filter status
            </label>
            <select
              id="integrations-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value as PlatformFilter)}
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
            >
              <option value="all" className="bg-black">All Statuses</option>
              <option value="connected" className="bg-black">Connected</option>
              <option value="not_connected" className="bg-black">Not Connected</option>
              <option value="attention_required" className="bg-black">Attention Required</option>
            </select>
          </div>

          <div className="w-full md:w-[190px]">
            <label htmlFor="integrations-sort" className="block text-xs uppercase tracking-[0.22em] text-white/35 mb-2">
              Sort by
            </label>
            <select
              id="integrations-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as IntegrationsSort)}
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
            >
              <option value="display_name_asc" className="bg-black">Name (A-Z)</option>
              <option value="display_name_desc" className="bg-black">Name (Z-A)</option>
              <option value="connection_state" className="bg-black">Status</option>
              <option value="health" className="bg-black">Health</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => integrations.refresh()}
            disabled={pageState === 'refreshing'}
            className="px-6 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all disabled:opacity-60"
          >
            {pageState === 'refreshing' ? 'Refreshing…' : 'Refresh list'}
          </button>
        </div>
      </div>

      {(pageState === 'loading' || pageState === 'refreshing') && visibleCards.length === 0 ? (
        <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 text-center text-white/60">
          Loading platform cards…
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 text-center text-white/60">
          No platforms match your current filters.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
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

      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-5 flex items-center gap-3 text-white/60">
        <Sparkles className="w-5 h-5 text-primary" />
        Connect and reconnect actions keep the browser inside Aries by routing through the branded OAuth interstitial.
      </div>
    </div>
  );
}
