'use client';

import { useEffect, useMemo, useState } from 'react';

import { BrandLogo } from '@/components/redesign/brand/logo';
import { createIntegrationsApi, isOauthErrorResult } from '@/lib/api/integrations';
import AuthLayout from './auth-layout';

type OAuthMode = 'connect' | 'reconnect';
type OAuthResultState = 'connected' | 'error' | 'pending';

export interface OAuthConnectScreenProps {
  provider: string;
  mode?: OAuthMode;
  connectionId?: string;
  result?: OAuthResultState;
  reason?: string;
  message?: string;
}

function callbackUrlFor(provider: string): string {
  if (typeof window === 'undefined') {
    return `http://localhost:3000/api/auth/oauth/${provider}/callback`;
  }

  return `${window.location.origin}/api/auth/oauth/${provider}/callback`;
}

function providerTitle(provider: string): string {
  if (provider === 'x') return 'X';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function OAuthConnectScreen({
  provider,
  mode = 'connect',
  connectionId,
  result,
  reason,
  message,
}: OAuthConnectScreenProps): JSX.Element {
  const api = useMemo(() => createIntegrationsApi(), []);
  const [status, setStatus] = useState<'idle' | 'starting' | 'redirecting' | 'error'>(
    result ? 'idle' : 'starting'
  );
  const [localMessage, setLocalMessage] = useState<string | null>(message ?? null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  useEffect(() => {
    if (result || status !== 'starting') {
      return;
    }

    let cancelled = false;

    async function begin(): Promise<void> {
      try {
        const response =
          mode === 'reconnect'
            ? await api.oauthReconnect(provider, {
                connection_id: connectionId || `current_${provider}`,
                redirect_uri: callbackUrlFor(provider),
              })
            : await api.oauthConnect(provider, {
                tenant_id: 'current',
                redirect_uri: callbackUrlFor(provider),
              });

        if (cancelled) {
          return;
        }

        if (isOauthErrorResult(response)) {
          setStatus('error');
          setLocalMessage(response.message || response.reason);
          return;
        }

        setAuthorizationUrl(response.authorization_url);
        setStatus('redirecting');
        window.location.assign(response.authorization_url);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setStatus('error');
        setLocalMessage(error instanceof Error ? error.message : 'Unable to start OAuth handoff.');
      }
    }

    void begin();

    return () => {
      cancelled = true;
    };
  }, [api, connectionId, mode, provider, result, status]);

  const heading =
    result === 'connected'
      ? `${providerTitle(provider)} connected`
      : result === 'error'
        ? `${providerTitle(provider)} connection failed`
        : mode === 'reconnect'
          ? `Reconnect ${providerTitle(provider)}`
          : `Connect ${providerTitle(provider)}`;

  const description =
    result === 'connected'
      ? 'The provider callback completed and Aries recorded the connection successfully.'
      : result === 'error'
        ? 'The callback returned an error or the OAuth handshake could not be completed.'
        : mode === 'reconnect'
          ? 'Aries is preparing a reauthorization handoff using the existing OAuth broker route.'
          : 'Aries is preparing a secure OAuth handoff using the existing broker route.';

  return (
    <AuthLayout>
      <div className="auth-container animate-in fade-in duration-1000" style={{ fontFamily: "'Inter', sans-serif" }}>
        <div className="flex flex-col items-center mb-6 text-center">
          <div className="mb-6">
            <BrandLogo size={96} variant="mark" priority />
          </div>
          <h1
            className="text-[26px] font-medium text-white tracking-[0.25em] mb-[20px] uppercase leading-none pl-[0.25em]"
            style={{ marginBottom: '20px' }}
          >
            {heading}
          </h1>
          <p className="text-white italic text-[18px] tracking-wide font-normal mt-[20px] opacity-90">
            {description}
          </p>
        </div>

        <div className="auth-card animate-in fade-in zoom-in-95 duration-500 space-y-6">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
            Provider handoff stays inside the Aries OAuth broker and callback namespace.
          </div>

          {status === 'starting' ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/80">
              Preparing secure handoff…
            </div>
          ) : null}

          {status === 'redirecting' ? (
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-center text-sm text-cyan-100">
              Redirecting to {providerTitle(provider)}…
            </div>
          ) : null}

          {result === 'connected' ? (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-center text-sm text-emerald-100">
              Connection completed. You can return to platforms and continue the demo.
            </div>
          ) : null}

          {(status === 'error' || result === 'error') && (
            <div
              className="rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 animate-in fade-in slide-in-from-top-3 duration-500"
              style={{ padding: '16px', borderLeft: '4px solid #EF4444' }}
            >
              <div
                className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30"
                style={{ width: '24px', height: '24px' }}
              >
                <svg className="text-red-400" style={{ width: '14px', height: '14px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <span
                className="text-red-100/90 font-bold tracking-normal leading-snug"
                style={{ fontSize: '10px', textTransform: 'capitalize', letterSpacing: '0.02em' }}
              >
                {localMessage || reason || 'OAuth handoff failed.'}
              </span>
            </div>
          )}

          {authorizationUrl ? (
            <button
              type="button"
              className="auth-primary-button"
              onClick={() => window.location.assign(authorizationUrl)}
            >
              Continue to {providerTitle(provider)}
            </button>
          ) : null}

          <a href="/platforms" className="auth-primary-button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
            Return to Platforms
          </a>
        </div>
      </div>
    </AuthLayout>
  );
}
