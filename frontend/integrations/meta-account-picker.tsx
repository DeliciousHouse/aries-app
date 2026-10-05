'use client';

import { useEffect, useState } from 'react';

type PageList = { connectedAccountId: string; pages: Array<{ id: string; name: string | null }> };

export default function MetaAccountPicker({ platform, required, onSelected, onReconnect }: {
  platform: 'facebook' | 'instagram';
  required: boolean;
  onSelected: () => Promise<void>;
  onReconnect: () => void;
}) {
  const [open, setOpen] = useState(required);
  const [list, setList] = useState<PageList | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const endpoint = `/api/integrations/composio/${platform}/pages`;

  useEffect(() => { if (required) setOpen(true); }, [required]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setList(null);
    setChoice('');
    setError(null);
    void (async () => {
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.message ?? 'Could not load pages.');
        if (!cancelled) {
          setList(body);
          setChoice(body.pages.length === 1 ? body.pages[0].id : '');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load pages.');
      }
    })();
    return () => { cancelled = true; };
  }, [open, endpoint, retry]);

  async function confirm() {
    if (!list || !choice) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageId: choice, connectedAccountId: list.connectedAccountId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not confirm the page.');
      await onSelected();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the page.');
    } finally { setBusy(false); }
  }

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="mt-4 min-h-11 text-sm text-sky-300 underline hover:text-sky-200">Change page</button>;
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-slate-600 bg-slate-800/50 p-4">
      <label htmlFor={`${platform}-page`} className="block text-base font-medium">
        {platform === 'facebook' ? 'Choose your Facebook page' : 'Confirm your Instagram business account'}
      </label>
      {!list && !error && <p role="status" className="text-sm text-slate-400">Loading available pages…</p>}
      {list && list.pages.length === 0 && <p className="text-sm text-amber-300">No pages are available on this connection.</p>}
      {list && list.pages.length > 0 && (
        <select id={`${platform}-page`} value={choice} onChange={e => setChoice(e.target.value)} disabled={busy}
          className="min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-base text-slate-100">
          <option value="">Select a page or account</option>
          {list.pages.map(page => <option key={page.id} value={page.id}>{page.name ?? page.id}</option>)}
        </select>
      )}
      <p className="text-base text-slate-400">
        Missing the expected page? Reconnect and use Facebook’s “Edit settings” to grant access to the right page.
        For Instagram, reconnect with the intended Business or Creator account.
      </p>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={confirm} disabled={!choice || busy}
          className="min-h-11 rounded-lg bg-violet-600 px-3 py-2 text-sm text-white hover:bg-violet-500 disabled:opacity-50">
          {busy ? 'Saving…' : 'Confirm page'}
        </button>
        <button type="button" onClick={() => setRetry(n => n + 1)} disabled={busy} className="min-h-11 text-sm text-sky-300 underline hover:text-sky-200">Refresh pages</button>
        <button type="button" onClick={onReconnect} disabled={busy} className="min-h-11 text-sm text-sky-300 underline hover:text-sky-200">Reconnect</button>
        {!required && <button type="button" onClick={() => setOpen(false)} disabled={busy} className="min-h-11 text-sm text-slate-300 underline hover:text-white">Cancel</button>}
      </div>
    </div>
  );
}
