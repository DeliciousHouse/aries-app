'use client';

import { type JSX, useCallback, useMemo, useState } from 'react';

import { FEEDBACK_REPORT_LIMITS } from '@/lib/feedback/report-options';

/**
 * Shared "something broke" surface for every Next.js error boundary.
 *
 * Demo feedback (David, item 4): a server error blew up mid-signup and the user
 * "moved too fast to grab the error number" — because there was no error number.
 * The app shipped with NO app/error.tsx and NO app/global-error.tsx, so every
 * uncaught server exception fell through to Next's bare default page.
 *
 * The contract here is that a user can ALWAYS walk away with a reference that
 * support can search for:
 *   - `digest` is Next.js's production error hash; it is written to the server
 *     log next to the stack, so it is the real correlation key.
 *   - when there is no digest (dev, or a client-side throw) we mint a local
 *     reference so the "report this" payload is still traceable.
 * The reference is rendered as selectable text (not just a copy button) so it
 * survives a screenshot, and the one-click report files it through the existing
 * /api/feedback/submit -> Jira pipeline with the reference in the title.
 */

export type ErrorSurfaceProps = {
  error: Error & { digest?: string };
  reset?: () => void;
  /** Headline override for surface-specific wording. */
  title?: string;
  /** Body copy override. */
  description?: string;
  /** Where the secondary "get me out of here" button goes. */
  homeHref?: string;
  homeLabel?: string;
};

function mintLocalReference(): string {
  // Not security-sensitive — this is a human-quotable support handle.
  const random = Math.random().toString(36).slice(2, 8);
  const stamp = Date.now().toString(36);
  return `local-${stamp}-${random}`.toUpperCase();
}

type ReportState = 'idle' | 'sending' | 'sent' | 'failed';

export default function ErrorSurface({
  error,
  reset,
  title = 'Something went wrong on our side',
  description = 'This is a fault in Aries, not something you did. Your saved work is not affected. Quote the reference below and we can trace exactly what happened.',
  homeHref = '/dashboard',
  homeLabel = 'Go to dashboard',
}: ErrorSurfaceProps): JSX.Element {
  const reference = useMemo(() => error.digest?.trim() || mintLocalReference(), [error.digest]);
  const [copied, setCopied] = useState(false);
  const [reportState, setReportState] = useState<ReportState>('idle');

  const copyReference = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(reference);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard blocked (insecure context / permissions) — the reference is
        // already on screen as selectable text, so this is a non-event.
      }
    })();
  }, [reference]);

  const sendReport = useCallback(() => {
    if (reportState === 'sending' || reportState === 'sent') {
      return;
    }
    setReportState('sending');

    void (async () => {
      try {
        const description = [
          `Error reference: ${reference}`,
          `Page: ${typeof window !== 'undefined' ? window.location.href : 'unknown'}`,
          `Reported at: ${new Date().toISOString()}`,
          '',
          'Auto-filed from the Aries error screen.',
        ]
          .join('\n')
          .slice(0, FEEDBACK_REPORT_LIMITS.descriptionMax);

        const response = await fetch('/api/feedback/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            category: 'bug',
            impact: 'p1_account_blocked',
            title: `Server error ${reference}`.slice(0, FEEDBACK_REPORT_LIMITS.titleMax),
            description,
          }),
        });

        setReportState(response.ok ? 'sent' : 'failed');
      } catch {
        setReportState('failed');
      }
    })();
  }, [reference, reportState]);

  return (
    <main className="min-h-screen bg-[#08070b] text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full border border-white/12 bg-white/5"
          aria-hidden="true"
        >
          <svg className="h-7 w-7 text-white/70" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
        </div>

        <p className="mt-6 text-xs uppercase tracking-[0.35em] text-white/70">Unexpected error</p>
        <h1 className="mt-4 text-4xl font-normal tracking-[-0.04em] text-white">{title}</h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">{description}</p>

        <div className="mt-8 w-full max-w-md rounded-2xl border border-white/12 bg-white/[0.04] p-5 text-left">
          <p className="text-xs uppercase tracking-[0.22em] text-white/40">Reference</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <code className="select-all break-all font-mono text-sm text-white" data-testid="error-reference">
              {reference}
            </code>
            <button
              type="button"
              onClick={copyReference}
              className="shrink-0 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-xs text-white transition hover:bg-white/10"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-white/45">
            Support can look this up directly. Include it in any message about this error.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {reset ? (
            <button
              type="button"
              onClick={reset}
              className="rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition hover:bg-white/90"
            >
              Try again
            </button>
          ) : null}
          <a
            href={homeHref}
            className="rounded-full border border-white/20 bg-white/5 px-6 py-2.5 text-sm text-white transition hover:bg-white/10"
          >
            {homeLabel}
          </a>
          <button
            type="button"
            onClick={sendReport}
            disabled={reportState === 'sending' || reportState === 'sent'}
            className="rounded-full border border-white/20 bg-transparent px-6 py-2.5 text-sm text-white/80 transition hover:bg-white/10 disabled:opacity-60"
          >
            {reportState === 'sent'
              ? 'Report sent'
              : reportState === 'sending'
                ? 'Sending…'
                : reportState === 'failed'
                  ? 'Retry report'
                  : 'Report this to support'}
          </button>
        </div>

        <div aria-live="polite" className="mt-4 min-h-[1.25rem] text-xs text-white/50">
          {reportState === 'sent' ? 'Thanks — the team has the details and your reference.' : null}
          {reportState === 'failed' ? 'We could not file the report. Please send the reference to support.' : null}
        </div>
      </div>
    </main>
  );
}
