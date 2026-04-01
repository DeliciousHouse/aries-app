'use client';

import { useEffect, useMemo, useState } from 'react';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, CheckCircle2, Chrome, LoaderCircle, ShieldAlert, Sparkles } from 'lucide-react';

import { createIntegrationsApi, isOauthErrorResult } from '@/lib/api/integrations';
import { AriesMark } from '@/frontend/donor/ui';
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

  const providerLabel = providerTitle(provider);

  return (
    <AuthLayout>
      <div className="max-w-md mx-auto">
        <Link href="/dashboard/settings/channel-integrations" className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors mb-8 group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          <span>Back to Channel Integrations</span>
        </Link>

        <div className="glass p-8 md:p-10 rounded-2xl border border-white/10 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />

          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 mb-4">
              <Sparkles className="w-6 h-6 text-primary" />
            </div>
            <div className="inline-flex items-center gap-3 mb-3">
              <AriesMark sizeClassName="w-10 h-10" />
              <span className="text-2xl font-bold tracking-tight">Aries AI</span>
            </div>
            <h1 className="text-3xl font-bold mb-2">{heading}</h1>
            <p className="text-white/60">{description}</p>
          </div>

          <div className="space-y-5">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
              Provider handoff stays inside the Aries OAuth broker and callback namespace.
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
              <div className="flex items-center gap-4">
                <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20">
                  {status === 'starting' ? (
                    <LoaderCircle className="w-6 h-6 text-primary animate-spin" />
                  ) : status === 'redirecting' ? (
                    <Chrome className="w-6 h-6 text-primary" />
                  ) : result === 'connected' ? (
                    <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="w-6 h-6 text-red-400" />
                  )}
                </div>
                <div>
                  <p className="text-sm uppercase tracking-[0.2em] text-white/40 mb-1">OAuth handoff</p>
                  <h2 className="text-lg font-semibold text-white">
                    {status === 'starting'
                      ? `Preparing ${providerLabel}`
                      : status === 'redirecting'
                        ? `Redirecting to ${providerLabel}`
                        : result === 'connected'
                          ? `${providerLabel} connected`
                          : `${providerLabel} handoff issue`}
                  </h2>
                </div>
              </div>
            </div>

            {status === 'starting' ? (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/80">
                Preparing secure handoff…
              </div>
            ) : null}

            {status === 'redirecting' ? (
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-center text-sm text-cyan-100">
                Redirecting to {providerLabel}…
              </div>
            ) : null}

            {result === 'connected' ? (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-center text-sm text-emerald-100">
                Connection completed. You can return to platforms and continue the demo.
              </div>
            ) : null}

            {(status === 'error' || result === 'error') ? (
              <div className="rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 p-4 border-l-4 border-l-red-500">
                <div className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30 w-6 h-6">
                  <svg className="text-red-400 w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <span className="text-red-100/90 text-xs font-bold tracking-normal leading-snug">
                  {localMessage || reason || 'OAuth handoff failed.'}
                </span>
              </div>
            ) : null}

            {authorizationUrl ? (
              <button
                type="button"
                className="w-full py-3 px-4 bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-white font-medium rounded-xl transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.5)] flex items-center justify-center gap-2"
                onClick={() => window.location.assign(authorizationUrl)}
              >
                Continue to {providerLabel}
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : null}

            <Link
              href="/dashboard/settings/channel-integrations"
              className="w-full py-3 px-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-colors text-sm font-medium flex items-center justify-center gap-2"
            >
              Return to Channel Integrations
            </Link>
          </div>
        </div>
      </div>
    </AuthLayout>
  );
}
