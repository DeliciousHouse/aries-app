'use client';

import { useEffect, useState } from 'react';
import PagePickerForm, { type PickerPage } from '@/app/onboarding/connect/meta/select-page/PagePickerForm';

type Choices = { connectedAccountId: string; pages: PickerPage[] };

export default function ComposioPageSelection({ platform, onSaved }: {
  platform: 'facebook' | 'instagram';
  onSaved: () => Promise<void>;
}) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const endpoint = `/api/integrations/composio/${platform}/pages`;
  useEffect(() => {
    let cancelled = false;
    setChoices(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || body?.status !== 'ok' || typeof body.connectedAccountId !== 'string' || !body.connectedAccountId.trim() ||
          !Array.isArray(body.pages) || body.pages.some((p: any) => !p || typeof p.id !== 'string' || !p.id.trim() || typeof p.name !== 'string' || !p.name.trim() || typeof p.hasInstagram !== 'boolean')) {
          throw new Error('Could not load account choices. Please retry or reconnect.');
        }
        if (!cancelled) setChoices(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load account choices.');
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint, attempt]);

  return <section className="mt-4 space-y-3" aria-label={`Choose ${platform} account`}>
    <p className="text-base text-slate-300">{platform === 'facebook' ? 'Choose and confirm the Page Aries will publish to.' : 'Confirm the Instagram business account Aries will publish to.'}</p>
    {platform === 'facebook' && <p className="text-base text-slate-400">Missing a Page? Reconnect, choose Facebook’s Edit settings, and allow access to the desired Page.</p>}
    {platform === 'instagram' && <p className="text-base text-slate-400">To use another business account, reconnect and choose it in Instagram.</p>}
    {error ? <div role="alert" className="text-sm text-rose-300">{error} <button type="button" className="underline" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>
      : !choices ? <p role="status">Loading available accounts…</p>
      : choices.pages.length === 0 ? <p role="status">No available Pages. Reconnect and review Facebook’s Edit settings.</p>
      : <PagePickerForm key={choices.connectedAccountId} pages={choices.pages} accountLabel={platform === 'facebook' ? 'Page' : 'account'} onSelect={async pageId => {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, connectedAccountId: choices.connectedAccountId }) });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.status !== 'ok') throw new Error(body?.message ?? 'Could not confirm the account. Reload and try again.');
        await onSaved();
      }} />}
  </section>;
}
