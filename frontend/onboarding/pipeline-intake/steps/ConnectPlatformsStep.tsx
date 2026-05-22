'use client';

import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import StepContainer from '../components/StepContainer';

const META_PLATFORM = 'facebook';
const IG_PLATFORM = 'instagram';

const META_OAUTH_HREF = '/oauth/connect/facebook';

export type ConnectionState =
  | 'connected'
  | 'connection_error'
  | 'reauth_required'
  | 'connection_pending'
  | 'disabled'
  | 'not_connected';

export type IntegrationCard = {
  platform: string;
  display_name?: string;
  description?: string;
  connection_state: ConnectionState;
  health?: string;
  available_actions?: string[];
  last_synced_at?: string | null;
  expires_at?: string | null;
  permissions?: string[];
  connection_id?: string;
  error?: {
    code: string;
    message: string;
  };
};

export type IntegrationsResponse = {
  status: string;
  cards?: IntegrationCard[];
  page_state?: string;
};

export type FetchStatus = 'idle' | 'loading' | 'ready' | 'error';

export function findCardByPlatform(
  cards: IntegrationCard[] | null | undefined,
  platform: string,
): IntegrationCard | null {
  if (!cards) return null;
  return cards.find((c) => c.platform === platform) ?? null;
}

export function hasAtLeastOneMetaConnection(
  cards: IntegrationCard[] | null | undefined,
): boolean {
  if (!cards || cards.length === 0) return false;
  return cards.some(
    (c) =>
      (c.platform === META_PLATFORM || c.platform === IG_PLATFORM) &&
      c.connection_state === 'connected',
  );
}

export function filterMetaAndInstagram(
  cards: IntegrationCard[] | null | undefined,
): IntegrationCard[] {
  if (!cards) return [];
  const facebook = findCardByPlatform(cards, META_PLATFORM);
  const instagram = findCardByPlatform(cards, IG_PLATFORM);
  return [facebook, instagram].filter((c): c is IntegrationCard => c !== null);
}

interface ConnectPlatformsStepProps {
  onNext: () => void;
  onBack: () => void;
  loadIntegrations?: () => Promise<IntegrationsResponse>;
  oauthHref?: string;
  initialCards?: IntegrationCard[];
}

type PlatformPresentation = {
  display: string;
  helper: string;
  glyph: string;
  glyphTone: 'meta' | 'ig';
};

const PLATFORM_PRESENTATION: Record<string, PlatformPresentation> = {
  [META_PLATFORM]: {
    display: 'Meta (Facebook)',
    helper:
      "We'll connect your Facebook Page so weekly posts can publish to Meta and pull through linked Instagram accounts.",
    glyph: '📣',
    glyphTone: 'meta',
  },
  [IG_PLATFORM]: {
    display: 'Instagram',
    helper:
      'Instagram connects automatically when you authorize Meta and pick a Page that has a linked Instagram Business Account.',
    glyph: '📸',
    glyphTone: 'ig',
  },
};

export default function ConnectPlatformsStep({
  onNext,
  onBack,
  loadIntegrations,
  oauthHref = META_OAUTH_HREF,
  initialCards,
}: ConnectPlatformsStepProps): JSX.Element {
  const [cards, setCards] = useState<IntegrationCard[] | null>(
    initialCards ? filterMetaAndInstagram(initialCards) : null,
  );
  const [status, setStatus] = useState<FetchStatus>(initialCards ? 'ready' : 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const focusDebounce = useRef<number | null>(null);

  const fetcher = useMemo(
    () =>
      loadIntegrations ??
      (async (): Promise<IntegrationsResponse> => {
        const res = await fetch('/api/integrations', { credentials: 'same-origin' });
        if (!res.ok) {
          throw new Error(`integrations_fetch_failed_${res.status}`);
        }
        return (await res.json()) as IntegrationsResponse;
      }),
    [loadIntegrations],
  );

  const refresh = useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);
    try {
      const payload = await fetcher();
      setCards(filterMetaAndInstagram(payload.cards));
      setStatus('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not load connection status.');
      setStatus('error');
    }
  }, [fetcher]);

  useEffect(() => {
    if (!initialCards) return;
    setCards(filterMetaAndInstagram(initialCards));
    setStatus('ready');
    setErrorMessage(null);
  }, [initialCards]);

  useEffect(() => {
    if (initialCards) return;
    void refresh();
  }, [initialCards, refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      if (focusDebounce.current !== null) {
        window.clearTimeout(focusDebounce.current);
      }
      focusDebounce.current = window.setTimeout(() => {
        focusDebounce.current = null;
        void refresh();
      }, 400);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (focusDebounce.current !== null) {
        window.clearTimeout(focusDebounce.current);
        focusDebounce.current = null;
      }
    };
  }, [refresh]);

  const canProceed = hasAtLeastOneMetaConnection(cards);
  const orderedCards = useMemo(() => {
    const fromApi = cards ?? [];
    return [META_PLATFORM, IG_PLATFORM].map((platform) => {
      const found = fromApi.find((c) => c.platform === platform);
      const fallback: IntegrationCard = {
        platform,
        display_name: PLATFORM_PRESENTATION[platform].display,
        connection_state: 'not_connected',
      };
      return found ?? fallback;
    });
  }, [cards]);

  return (
    <StepContainer
      stepNumber={5}
      totalSteps={6}
      title="Connect your social accounts"
      subtitle="Link at least one account so Aries can publish your weekly social content. Meta covers Facebook, and your Instagram Business Account connects through it automatically."
      canProceed={canProceed}
      onNext={onNext}
      onBack={onBack}
    >
      <div className="space-y-3" data-testid="connect-platforms-cards">
        {orderedCards.map((card) => (
          <ConnectionCard
            key={card.platform}
            card={card}
            oauthHref={oauthHref}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-[#666]">
          {canProceed
            ? 'At least one social account is connected. You can launch when ready.'
            : 'Connect Meta or Instagram to continue. We never post anything without your approval.'}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={status === 'loading'}
          className="inline-flex items-center gap-2 rounded-full border border-[#1e1e2e] bg-[#111118] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#888] hover:border-[#2a2a3e] hover:text-white transition-colors disabled:opacity-60"
          aria-label="Refresh connection status"
          data-testid="connect-platforms-refresh"
        >
          {status === 'loading' ? (
            <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="w-3.5 h-3.5" />
          )}
          {status === 'loading' ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {status === 'error' && errorMessage ? (
        <div
          role="alert"
          data-testid="connect-platforms-error"
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300"
        >
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
          We couldn&apos;t load connection status. Try again or refresh after connecting.
        </div>
      ) : null}
    </StepContainer>
  );
}

interface ConnectionCardProps {
  card: IntegrationCard;
  oauthHref: string;
}

function ConnectionCard({ card, oauthHref }: ConnectionCardProps): JSX.Element {
  const presentation: PlatformPresentation = PLATFORM_PRESENTATION[card.platform] ?? {
    display: card.display_name ?? card.platform,
    helper: '',
    glyph: '🔗',
    glyphTone: 'meta',
  };

  const state = card.connection_state;
  const isConnected = state === 'connected';
  const needsAttention = state === 'connection_error' || state === 'reauth_required';
  const isDisabled = state === 'disabled';

  const ctaLabel = isConnected
    ? 'Reconnect'
    : needsAttention
      ? 'Reconnect'
      : 'Connect';

  return (
    <div
      data-testid={`connect-card-${card.platform}`}
      data-state={state}
      className={`flex items-start gap-4 rounded-2xl border p-5 transition-all duration-200 ${
        isConnected
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : needsAttention
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-[#1e1e2e] bg-[#111118] hover:border-[#2a2a3e]'
      }`}
    >
      <div
        aria-hidden="true"
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg ${
          presentation.glyphTone === 'meta'
            ? 'bg-[#1877f2]/15 text-[#5b8dee]'
            : 'bg-[#e4405f]/15 text-[#e4405f]'
        }`}
      >
        <span aria-hidden="true">{presentation.glyph}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-white">{presentation.display}</h3>
          <StatusPill state={state} />
        </div>
        <p className="mt-1 text-xs text-[#888] leading-relaxed">
          {presentation.helper}
        </p>
        {needsAttention && card.error?.message ? (
          <p
            className="mt-2 text-xs text-amber-300"
            data-testid={`connect-card-error-${card.platform}`}
          >
            {card.error.message}
          </p>
        ) : null}
      </div>

      <a
        href={oauthHref}
        data-testid={`connect-card-cta-${card.platform}`}
        aria-disabled={isDisabled || undefined}
        tabIndex={isDisabled ? -1 : undefined}
        onClick={(event) => {
          if (isDisabled) {
            event.preventDefault();
          }
        }}
        className={`shrink-0 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200 ${
          isDisabled
            ? 'pointer-events-none cursor-not-allowed bg-[#1e1e2e] text-[#444]'
            : isConnected
              ? 'border border-emerald-500/40 bg-transparent text-emerald-300 hover:bg-emerald-500/10'
              : 'bg-aries-crimson text-white shadow-lg shadow-aries-crimson/20 hover:bg-aries-deep'
        }`}
      >
        {ctaLabel}
      </a>
    </div>
  );
}

interface StatusPillProps {
  state: ConnectionState;
}

function StatusPill({ state }: StatusPillProps): JSX.Element {
  if (state === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300">
        <Check aria-hidden="true" className="h-3 w-3" />
        Connected
      </span>
    );
  }
  if (state === 'connection_error' || state === 'reauth_required') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">
        <AlertTriangle aria-hidden="true" className="h-3 w-3" />
        Needs attention
      </span>
    );
  }
  if (state === 'connection_pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300">
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
        Pending
      </span>
    );
  }
  if (state === 'disabled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[#2a2a3e] bg-[#1e1e2e] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#888]">
        Unavailable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#2a2a3e] bg-[#1e1e2e] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#888]">
      Not connected
    </span>
  );
}
