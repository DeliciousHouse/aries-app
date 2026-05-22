'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { FacebookIcon } from './brand-icons';

export interface FacebookPublishDrawerProps {
  jobId: string;
  defaultCaption?: string;
  onClose: () => void;
  onPublished?: (result: FacebookPublishResult) => void;
}

export interface FacebookPublishResult {
  platform_post_id: string;
  permalink: string | null;
}

export default function FacebookPublishDrawer(props: FacebookPublishDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [caption, setCaption] = useState(props.defaultCaption ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<FacebookPublishResult | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) {
        props.onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, submitting]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/marketing/jobs/${encodeURIComponent(props.jobId)}/publish-facebook`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ caption: caption.trim() }),
        },
      );

      const payload = (await response.json().catch(() => null)) as
        | { status: string; platform_post_id?: string; permalink?: string | null; message?: string; reason?: string }
        | null;

      if (!response.ok || payload?.status !== 'published') {
        setErrorMessage(
          payload?.message || payload?.reason || 'Facebook publish failed. Try again in a moment.',
        );
        return;
      }

      const publishResult: FacebookPublishResult = {
        platform_post_id: payload.platform_post_id ?? '',
        permalink: payload.permalink ?? null,
      };
      setResult(publishResult);
      props.onPublished?.(publishResult);
    } catch {
      setErrorMessage('Network error while publishing. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fb-publish-drawer-title"
      data-testid="facebook-publish-drawer"
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 px-4 pb-6 pt-20 backdrop-blur-sm sm:items-center sm:pb-12"
    >
      <button
        type="button"
        aria-label="Close publish drawer"
        onClick={props.onClose}
        className="absolute inset-0 cursor-default"
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#101418]/95 shadow-[0_32px_120px_rgba(0,0,0,0.5)] backdrop-blur-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/8 px-6 py-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80">
              <FacebookIcon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">Publish now</p>
              <h2 id="fb-publish-drawer-title" className="mt-1 text-base font-semibold text-white">
                Publish to Facebook Page
              </h2>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={props.onClose}
            disabled={submitting}
            className="rounded-full border border-white/10 p-2 text-white/65 transition hover:border-white/20 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {result ? (
          <div className="space-y-4 px-6 py-5">
            <p className="rounded-[0.85rem] border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
              Published successfully.
            </p>
            {result.permalink ? (
              <a
                href={result.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:border-white/20 hover:text-white"
              >
                View on Facebook
                <ArrowUpRight className="h-4 w-4" />
              </a>
            ) : null}
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">
            <label className="block space-y-2 text-sm" htmlFor="fb-publish-caption">
              <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">Caption</span>
              <textarea
                id="fb-publish-caption"
                data-testid="fb-publish-caption"
                value={caption}
                onChange={(event) => {
                  setErrorMessage(null);
                  setCaption(event.target.value);
                }}
                rows={5}
                placeholder="Write a caption for this post…"
                className="w-full rounded-[1rem] border border-white/12 bg-black/30 px-4 py-3 text-sm text-white placeholder:text-white/30 focus:border-white/35 focus:outline-none"
              />
              <span className="text-xs text-white/45">
                Posting immediately to the connected Facebook Page.
              </span>
            </label>

            {errorMessage ? (
              <p
                role="alert"
                data-testid="fb-publish-error"
                className="rounded-[0.85rem] border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-sm text-rose-100"
              >
                {errorMessage}
              </p>
            ) : null}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-white/8 bg-black/15 px-6 py-4">
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting}
            className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white disabled:opacity-60"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result ? (
            <button
              type="submit"
              data-testid="fb-publish-submit"
              disabled={submitting}
              style={{ color: '#11161c' }}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-60"
            >
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FacebookIcon className="h-4 w-4" />}
              {submitting ? 'Publishing…' : 'Publish now'}
            </button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}
