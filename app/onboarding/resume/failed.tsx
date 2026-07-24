'use client';

import { type JSX, useCallback, useState } from 'react';

import { FEEDBACK_REPORT_LIMITS } from '@/lib/feedback/report-options';

/**
 * Recoverable failure screen for the onboarding handoff.
 *
 * Demo feedback (David, items 3 + 4): after creating his account he hit a raw
 * server error, then "looped back to the set up your site thing" with nothing
 * saved. The mechanism was that `/onboarding/resume` rethrew any materialization
 * failure (brand-kit scrape of an unreachable site, job submit, etc.), which
 * produced a bare 500 — and because onboarding drafts carry no owner column,
 * navigating back to `/onboarding/start` WITHOUT the `?draft=` param minted a
 * brand-new empty draft and orphaned everything he had typed.
 *
 * This screen replaces the 500 and, critically, keeps the draft id in the user's
 * hands: "Review your setup" links back into the wizard WITH the draft, so the
 * work is still there.
 */
export default function OnboardingResumeFailed({
  draftId,
  reference,
}: {
  draftId: string;
  reference: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [reportState, setReportState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const resumeHref = `/onboarding/resume?draft=${encodeURIComponent(draftId)}`;
  const editHref = `/onboarding/start?draft=${encodeURIComponent(draftId)}`;

  const copyReference = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(reference);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        // Selectable on screen regardless.
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
        const response = await fetch('/api/feedback/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            category: 'bug',
            impact: 'p1_account_blocked',
            title: `Onboarding handoff failed ${reference}`.slice(0, FEEDBACK_REPORT_LIMITS.titleMax),
            description: [
              `Error reference: ${reference}`,
              `Draft: ${draftId}`,
              `Reported at: ${new Date().toISOString()}`,
              '',
              'Auto-filed from the onboarding handoff failure screen.',
            ]
              .join('\n')
              .slice(0, FEEDBACK_REPORT_LIMITS.descriptionMax),
          }),
        });
        setReportState(response.ok ? 'sent' : 'failed');
      } catch {
        setReportState('failed');
      }
    })();
  }, [draftId, reference, reportState]);

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

        <p className="mt-6 text-xs uppercase tracking-[0.35em] text-white/70">Onboarding handoff</p>
        <h1 className="mt-4 text-4xl font-normal tracking-[-0.04em] text-white">
          Your account is ready — we could not finish the first plan
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">
          <strong className="font-medium text-white">Everything you entered is saved.</strong> The
          usual cause is that we could not read your website automatically — most often because it
          sits behind bot protection such as Cloudflare, which blocks our reader. That is not
          something you did wrong. Try again, or review your setup and continue; you can fill in the
          brand details by hand and connect the site later.
        </p>

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
          <a
            href={resumeHref}
            className="rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition hover:bg-white/90"
          >
            Try again
          </a>
          <a
            href={editHref}
            className="rounded-full border border-white/20 bg-white/5 px-6 py-2.5 text-sm text-white transition hover:bg-white/10"
          >
            Review your setup
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
