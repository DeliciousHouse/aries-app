'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { InstagramIcon } from './brand-icons';

export type InstagramPublishFailure = {
  userMessage: string;
  retryable: boolean;
  code: string;
};

export interface InstagramPublishDrawerProps {
  jobId: string;
  defaultCaption?: string;
  onClose: () => void;
  onPublished?: (result: InstagramPublishResult) => void;
  onError?: (failure: InstagramPublishFailure) => void;
}

export interface InstagramPublishResult {
  platform_post_id: string;
  permalink: string | null;
}

type PublishErrorState = {
  userMessage: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
  code: string;
};

type PublishApiResponse = {
  status: string;
  platform_post_id?: string;
  permalink?: string | null;
  message?: string;
  reason?: string;
  code?: string;
  retryable?: boolean;
  retryAfterSeconds?: number | null;
};

function mapErrorToUserMessage(code: string | undefined, serverMessage: string | undefined): string {
  switch (code) {
    case 'oauth_token_missing':
    case 'external_account_missing':
      return 'No Meta account connected. Reconnect Meta to publish.';
    case 'graph_rate_limited':
      return 'Meta API rate-limited. Try again in a moment.';
    case 'graph_network_error':
      return 'Network error reaching Meta. Check your connection and try again.';
    case 'instagram_media_required':
      return 'Image fetch failed — no approved media available. Try regenerating creative.';
    case 'no_content':
      return 'Nothing to publish — caption and image are both missing.';
    case 'publish_requires_approval':
    case 'publish_approval_already_consumed':
      return 'Publish approval not found or already used.';
    case 'graph_api_error': {
      const msg = serverMessage?.toLowerCase() ?? '';
      if (msg.includes('permission')) return 'Page permission revoked. Re-authorize Meta to restore access.';
      if (msg.includes('token') || msg.includes('expired')) return 'Meta token expired. Reconnect Meta to publish.';
      if (msg.includes('caption') || msg.includes('policy')) return 'Caption violates Instagram policy. Edit the caption and try again.';
      return serverMessage ?? 'Meta returned an error. Try again or reconnect Meta.';
    }
    default:
      return serverMessage ?? 'Instagram publish failed. Try again in a moment.';
  }
}

function needsReconnect(code: string | undefined, userMessage: string): boolean {
  if (code === 'oauth_token_missing' || code === 'external_account_missing') return true;
  if (code === 'graph_api_error' && (userMessage.includes('permission') || userMessage.includes('token expired'))) return true;
  return false;
}

export default function InstagramPublishDrawer(props: InstagramPublishDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [caption, setCaption] = useState(props.defaultCaption ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [publishError, setPublishError] = useState<PublishErrorState | null>(null);
  const [result, setResult] = useState<InstagramPublishResult | null>(null);

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

  async function doPublish() {
    setSubmitting(true);
    setPublishError(null);

    try {
      const response = await fetch(
        `/api/marketing/jobs/${encodeURIComponent(props.jobId)}/publish-instagram`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ caption: caption.trim() }),
        },
      );

      const payload = (await response.json().catch(() => null)) as PublishApiResponse | null;

      if (!response.ok || payload?.status !== 'published') {
        const code = payload?.code ?? payload?.reason;
        const serverMessage = payload?.message;
        const userMessage = mapErrorToUserMessage(code, serverMessage);
        const errorState: PublishErrorState = {
          userMessage,
          retryable: payload?.retryable ?? response.status >= 500,
          retryAfterSeconds: payload?.retryAfterSeconds ?? null,
          code: code ?? 'publish_failed',
        };
        setPublishError(errorState);
        props.onError?.({ userMessage, retryable: errorState.retryable, code: errorState.code });
        return;
      }

      const publishResult: InstagramPublishResult = {
        platform_post_id: payload.platform_post_id ?? '',
        permalink: payload.permalink ?? null,
      };
      setResult(publishResult);
      props.onPublished?.(publishResult);
    } catch {
      const networkError: PublishErrorState = {
        userMessage: 'Network error while publishing. Check your connection and try again.',
        retryable: true,
        retryAfterSeconds: null,
        code: 'network_error',
      };
      setPublishError(networkError);
      props.onError?.({ userMessage: networkError.userMessage, retryable: true, code: 'network_error' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    await doPublish();
  }

  async function handleRetry() {
    if (submitting) return;
    await doPublish();
  }

  const showReconnect = publishError ? needsReconnect(publishError.code, publishError.userMessage) : false;
  const retryHint = publishError?.retryable && publishError.retryAfterSeconds
    ? `Try again in ${publishError.retryAfterSeconds}s`
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ig-publish-drawer-title"
      data-testid="instagram-publish-drawer"
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
              <InstagramIcon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">Publish now</p>
              <h2 id="ig-publish-drawer-title" className="mt-1 text-base font-semibold text-white">
                Publish to Instagram
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
                View on Instagram
                <ArrowUpRight className="h-4 w-4" />
              </a>
            ) : null}
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">
            <label className="block space-y-2 text-sm" htmlFor="ig-publish-caption">
              <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">Caption</span>
              <textarea
                id="ig-publish-caption"
                data-testid="ig-publish-caption"
                value={caption}
                onChange={(event) => {
                  setPublishError(null);
                  setCaption(event.target.value);
                }}
                rows={5}
                placeholder="Write a caption for this post…"
                className="w-full rounded-[1rem] border border-white/12 bg-black/30 px-4 py-3 text-sm text-white placeholder:text-white/30 focus:border-white/35 focus:outline-none"
              />
              <span className="text-xs text-white/45">
                Posting immediately to the connected Instagram account.
              </span>
            </label>

            {publishError ? (
              <div
                role="alert"
                data-testid="ig-publish-error"
                className="rounded-[0.85rem] border border-rose-300/25 bg-rose-300/10 px-3 py-2.5"
              >
                <p className="text-sm text-rose-100">{publishError.userMessage}</p>
                {retryHint ? (
                  <p className="mt-1 text-xs text-rose-200/60">{retryHint}</p>
                ) : null}
                {(publishError.retryable || showReconnect) ? (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {publishError.retryable ? (
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={submitting}
                        data-testid="ig-publish-retry"
                        className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs font-medium text-rose-100 transition hover:bg-rose-300/20 disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                      </button>
                    ) : null}
                    {showReconnect ? (
                      <a
                        href="/oauth/connect/instagram?mode=reconnect"
                        data-testid="ig-publish-reconnect"
                        className="inline-flex items-center gap-1.5 rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs font-medium text-rose-100 transition hover:bg-rose-300/20"
                      >
                        Reconnect Meta
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
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
              data-testid="ig-publish-submit"
              disabled={submitting}
              style={{ color: '#11161c' }}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-60"
            >
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <InstagramIcon className="h-4 w-4" />}
              {submitting ? 'Publishing…' : 'Publish now'}
            </button>
          ) : null}
        </footer>
      </form>
    </div>
  );
}
