'use client';

import { useState } from 'react';

export type PickerPage = {
  id: string;
  name: string;
  hasInstagram: boolean;
};

type Props = {
  state: string;
  pages: PickerPage[];
};

export default function MetaPagePickerForm({ state, pages }: Props) {
  const [selectedPageId, setSelectedPageId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPageId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/oauth/meta/select-page', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, page_id: selectedPageId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        reason?: string;
        facebook_connection_id?: string;
      };
      if (!response.ok || payload.status !== 'ok') {
        throw new Error(payload.message || payload.reason || 'select_page_failed');
      }
      const targetUrl = `/oauth/connect/facebook?result=connected${
        payload.facebook_connection_id ? `&connection_id=${encodeURIComponent(payload.facebook_connection_id)}` : ''
      }`;
      window.location.href = targetUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Page selection failed.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="sr-only">Available Facebook Pages</legend>
        {pages.map((page) => {
          const checked = selectedPageId === page.id;
          return (
            <label
              key={page.id}
              data-testid={`meta-page-option-${page.id}`}
              className={`flex items-start gap-3 rounded-xl border p-4 transition-all duration-200 cursor-pointer ${
                checked
                  ? 'border-aries-crimson bg-[#1a0e16]'
                  : 'border-[#1e1e2e] bg-[#111118] hover:border-[#2a2a3e]'
              }`}
            >
              <input
                type="radio"
                name="meta_page_id"
                value={page.id}
                checked={checked}
                onChange={() => setSelectedPageId(page.id)}
                className="mt-1 accent-aries-crimson"
                aria-label={`Select Page ${page.name}`}
              />
              <span className="flex-1">
                <span className="block text-white font-semibold">{page.name}</span>
                <span className="block text-xs text-[#888] mt-1" data-testid={`meta-page-ig-status-${page.id}`}>
                  {page.hasInstagram ? 'Instagram Business Account ready' : 'No Instagram Business Account'}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {error ? (
        <p className="text-sm text-[#ff8a8a]" role="alert" data-testid="meta-page-picker-error">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!selectedPageId || submitting}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all duration-200 ml-auto ${
            selectedPageId && !submitting
              ? 'bg-aries-crimson text-white hover:bg-aries-deep shadow-lg shadow-aries-crimson/20 hover:shadow-aries-crimson/30'
              : 'bg-[#1e1e2e] text-[#444] cursor-not-allowed'
          }`}
        >
          {submitting ? 'Connecting…' : 'Use this Page'}
        </button>
      </div>
    </form>
  );
}
