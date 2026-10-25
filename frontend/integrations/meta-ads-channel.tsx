'use client';

import { useEffect, useState } from 'react';
import { requestJson } from '@/lib/api/http';
import type { AdAccount, AdCampaign } from '@/backend/integrations/meta/ads';

type AdsData = {
  connected: boolean; connectionId: string | null; accounts: AdAccount[]; accountId: string | null;
  currency?: string | null; campaigns?: AdCampaign[];
};

/** Same tenant-owned account on settings and insights; no paid actions in this release. */
export default function MetaAdsChannel({ performance = false, period = '30day' }: { performance?: boolean; period?: string }) {
  const [data, setData] = useState<AdsData | null>(null);
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void requestJson<AdsData>('/api/integrations/meta-ads', {
      query: performance ? { performance: 1, period: period === 'week' ? '7day' : period } : {},
      cache: 'no-store', signal: controller.signal,
    }).then(body => {
      if (!controller.signal.aborted) { setData(body); setAccountId(body.accountId ?? ''); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load Meta Ads.'); });
    return () => controller.abort();
  }, [performance, period, attempt]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const response = await requestJson<{ authorization_url: string }>('/api/auth/oauth/meta_ads/connect', { method: 'POST', body: '{}' });
      window.location.href = response.authorization_url;
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not connect Meta Ads.'); setBusy(false); }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/integrations/meta-ads', { method: 'POST', body: JSON.stringify({ accountId, connectionId: data?.connectionId }) });
      setAttempt(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not confirm the account.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/integrations/disconnect', { method: 'POST', body: JSON.stringify({ platform: 'meta_ads' }) });
      setAttempt(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not disconnect Meta Ads.'); }
    finally { setBusy(false); }
  }

  const button = 'min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 disabled:opacity-50';
  const value = (metric: number | null) => metric === null ? 'Unavailable' : metric.toLocaleString();
  return <section aria-label="Meta Ads account" className="min-w-0 rounded-xl border border-slate-700 bg-slate-900/40 p-5 text-slate-100">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-medium">{performance ? 'Meta Ads performance' : 'Meta Ads account'}</h2>
      <span className="rounded-full bg-sky-500/15 px-3 py-1 text-xs text-sky-300">{performance ? 'Read-only' : 'Reporting only'}</span>
    </div>
    <p className="mt-2 text-sm text-slate-400">Separate from your organic Facebook Page. Aries can report on existing campaigns; creating or boosting ads is not enabled.</p>
    {error ? <div role="alert" className="mt-4 text-sm text-rose-300">{error} <button className={button} onClick={() => setAttempt(value => value + 1)}>Retry</button>
      {!performance && <button className={button} onClick={disconnect} disabled={busy}>Disconnect to reconnect</button>}</div>
      : !data ? <p role="status" className="mt-4 text-sm">Loading ad account…</p>
      : !data.connected ? <div className="mt-4">{performance ? <a className="text-sm text-sky-300 underline" href="/dashboard/settings/channel-integrations">Connect a Meta Ads account to see paid results</a>
        : <button className={button} onClick={connect} disabled={busy}>{busy ? 'Starting…' : 'Connect Meta Ads account'}</button>}</div>
      : performance ? !data.accountId ? <a className="mt-4 block text-sm text-sky-300 underline" href="/dashboard/settings/channel-integrations">Choose an ad account in Connections</a>
        : <div className="mt-4">
          <p className="text-sm text-slate-300">{data.accounts.find(account => account.id === data.accountId)?.name} · {data.accountId} · Last {period === 'week' ? '7' : period === '90day' ? '90' : '30'} days</p>
          {!data.campaigns?.length ? <p role="status" className="mt-3 text-sm text-slate-400">No campaigns available for this account.</p>
            : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
              <caption className="sr-only">Paid campaign performance, separate from organic results</caption>
              <thead className="text-slate-400"><tr>{['Campaign', 'Status', `Spend (${data.currency ?? 'currency unavailable'})`, 'Impressions', 'Clicks'].map(label => <th className="px-3 py-2" scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{data.campaigns.map(campaign => <tr className="border-t border-slate-700" key={campaign.id}>
                <th scope="row" className="px-3 py-3 font-medium">{campaign.name}</th><td className="px-3 py-3">{campaign.status}</td><td className="px-3 py-3">{value(campaign.spend)}</td><td className="px-3 py-3">{value(campaign.impressions)}</td><td className="px-3 py-3">{value(campaign.clicks)}</td>
              </tr>)}</tbody>
            </table></div>}
        </div>
      : <div className="mt-4 space-y-3">
        <label className="block text-sm" htmlFor="meta-ads-account">Ad account</label>
        <select id="meta-ads-account" className="min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3" value={accountId} onChange={event => setAccountId(event.target.value)} disabled={busy}>
          <option value="">Choose an account</option>{data.accounts.map(account => <option value={account.id} key={account.id}>{account.name} · {account.id}{account.currency ? ` · ${account.currency}` : ''}</option>)}
        </select>
        {!data.accounts.length && <p className="text-sm text-slate-400">No ad accounts available. Reconnect and allow access to the account you want to use.</p>}
        {data.accountId && <p role="status" className="text-sm text-emerald-300">Selected: {data.accounts.find(account => account.id === data.accountId)?.name} · {data.accountId}</p>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !accountId} onClick={save}>{busy ? 'Saving…' : 'Confirm ad account'}</button><button className={button} onClick={disconnect} disabled={busy}>Disconnect</button><a className={`${button} inline-flex items-center`} href="/insights">View ad performance</a></div>
      </div>}
  </section>;
}
