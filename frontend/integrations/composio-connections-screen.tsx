'use client';

/**
 * Connections screen for the optional Composio integration (Phase 9).
 *
 * Deliberately self-contained and isolated (no coupling to the typed app-shell
 * nav) so the whole feature is removable. Copy is written for a nontechnical
 * business owner: it never says OAuth, token, redirect URI, app secret, or auth
 * config. The flow is: see status -> click Connect -> approve -> done.
 */

import { useCallback, useEffect, useState } from 'react';

type Capabilities = {
  canPublishOrganic: boolean;
  canPublishAds: boolean;
  canReadPostInsights: boolean;
  canReadAdInsights: boolean;
  canUploadMedia: boolean;
  missingPermissions: string[];
  warnings: string[];
  provider: string;
};

type Connection = {
  platform: string;
  provider: string;
  status: 'not_connected' | 'pending' | 'connected' | 'reauthorization_required' | 'error';
  externalAccountName: string | null;
  capabilities: Capabilities | null;
};

type ListResponse = {
  status: string;
  composioEnabled: boolean;
  publishProvider: string;
  analyticsProvider: string;
  connections: Connection[];
};

const PLATFORM_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  meta_ads: 'Meta Ads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
};

function statusText(status: Connection['status'], caps: Capabilities | null): { label: string; tone: string } {
  if (status === 'connected') {
    const missing = caps && caps.missingPermissions.length > 0;
    return missing
      ? { label: 'Connected — some features need attention', tone: 'amber' }
      : { label: 'Connected and ready', tone: 'green' };
  }
  if (status === 'pending') return { label: 'Waiting for you to finish connecting', tone: 'blue' };
  if (status === 'reauthorization_required') return { label: 'Please reconnect', tone: 'amber' };
  if (status === 'error') return { label: 'Something went wrong — try reconnecting', tone: 'red' };
  return { label: 'Not connected', tone: 'gray' };
}

const TONE_CLASS: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  blue: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
  red: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
  gray: 'bg-slate-500/15 text-slate-300 border border-slate-500/30',
};

function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        on ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/50 text-slate-400'
      }`}
    >
      <span aria-hidden>{on ? '✓' : '—'}</span>
      {label}
    </span>
  );
}

export default function ComposioConnectionsScreen() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/composio', { cache: 'no-store' });
      const body = (await res.json()) as ListResponse & { message?: string };
      if (!res.ok) throw new Error(body.message ?? 'Could not load connections.');
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load connections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(async (platform: string) => {
    setBusy(platform);
    try {
      const res = await fetch(`/api/integrations/composio/${platform}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestedCapability: 'full' }),
      });
      const body = (await res.json()) as { connectUrl?: string; message?: string };
      if (!res.ok || !body.connectUrl) throw new Error(body.message ?? 'Could not start the connection.');
      window.location.href = body.connectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the connection.');
      setBusy(null);
    }
  }, []);

  const disconnect = useCallback(
    async (platform: string) => {
      setBusy(platform);
      try {
        const res = await fetch(`/api/integrations/composio/${platform}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = (await res.json()) as { message?: string };
          throw new Error(body.message ?? 'Could not disconnect.');
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not disconnect.');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-slate-100">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="mt-2 text-sm text-slate-400">
          Connect your social and advertising accounts so Aries can publish and report on your behalf. Just click
          Connect, approve the permissions, and pick the account or page you want to use.
        </p>
      </header>

      {data && !data.composioEnabled && (
        <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
          Account connections aren’t turned on for this workspace yet. Your existing publishing continues to work
          unchanged.
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
      )}

      {loading && <p className="text-sm text-slate-400">Loading your connections…</p>}

      <div className="space-y-4">
        {data?.connections.map((conn) => {
          const caps = conn.capabilities;
          const st = statusText(conn.status, caps);
          const isConnected = conn.status === 'connected';
          return (
            <div key={conn.platform} className="rounded-xl border border-slate-700 bg-slate-900/40 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-medium">{PLATFORM_LABEL[conn.platform] ?? conn.platform}</h2>
                  {conn.externalAccountName && (
                    <p className="mt-0.5 text-xs text-slate-400">{conn.externalAccountName}</p>
                  )}
                  <span className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-medium ${TONE_CLASS[st.tone]}`}>
                    {st.label}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  {isConnected ? (
                    <button
                      type="button"
                      onClick={() => disconnect(conn.platform)}
                      disabled={busy === conn.platform}
                      className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busy === conn.platform ? '…' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connect(conn.platform)}
                      disabled={busy === conn.platform || (data ? !data.composioEnabled : true)}
                      className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                    >
                      {busy === conn.platform ? 'Starting…' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>

              {caps && isConnected && (
                <>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Chip on={caps.canPublishOrganic} label="Publishing" />
                    <Chip on={caps.canReadPostInsights || caps.canReadAdInsights} label="Analytics" />
                    <Chip on={caps.canPublishAds} label="Ads (paused drafts)" />
                  </div>
                  {caps.warnings.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs text-amber-300/90">
                      {caps.warnings.map((w, i) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
