'use client';

import Link from 'next/link';

import type {
  RankedSlot,
  WeeklyResultsReport as WeeklyResultsReportShape,
} from '@/backend/marketing/weekly-results-report';

import { useWeeklyResults } from '@/hooks/use-weekly-results';
import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, ShellPanel } from './components';

/**
 * S5-1 / AA-110 — the weekly results panel, rendered ABOVE the existing roster
 * on /dashboard/results. Reuses the shipped shell primitives; introduces no new
 * design language (the brand redesign is a separate roadmap item).
 *
 * Renders nothing at all when the flag is off, so the screen stays byte-identical
 * to today.
 */
export default function WeeklyResultsReport() {
  const results = useWeeklyResults({ autoLoad: true });

  // `idle` counts as pending, not as "nothing to show". useEffect does not run
  // during SSR, so on first paint status is 'idle' with no data — without this
  // the panel renders null server-side and then pops in after the client fetch,
  // shoving the roster down the page.
  const pending = results.status === 'idle' || (results.isLoading && !results.data);
  if (pending) {
    return (
      <ShellPanel eyebrow="This week" title="Weekly results">
        <p className="text-sm leading-7 text-white/55">Loading this week’s results…</p>
      </ShellPanel>
    );
  }

  if (results.error) {
    return (
      <ShellPanel eyebrow="This week" title="Weekly results">
        <p className="text-sm leading-7 text-white/65">
          {customerSafeUiErrorMessage(
            results.error.message,
            'This week’s results are not available right now.',
          )}
        </p>
        <button
          type="button"
          onClick={() => void results.reload()}
          data-print-hidden
          className="print-hidden mt-3 inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.1]"
        >
          Try again
        </button>
      </ShellPanel>
    );
  }

  // Flag off (or nothing loaded yet) — render nothing, exactly like today.
  if (!results.data || results.data.enabled !== true) return null;

  const report = results.data.report;
  return <WeeklyResultsPanel report={report} />;
}

export function WeeklyResultsPanel({
  report,
  /** Injected in tests; real callers get the browser's print dialog. */
  onPrint,
}: {
  report: WeeklyResultsReportShape;
  onPrint?: () => void;
}) {
  const summaryLine = [
    `${report.published.total} published`,
    `${report.skipped.total} skipped`,
    `${report.blocked.total} blocked`,
  ].join(' · ');

  const print = () => {
    if (onPrint) return onPrint();
    if (typeof window !== 'undefined') window.print();
  };

  return (
    // S8-3/AA-126: this attribute is what the @media print block in globals.css
    // keys on. Scoping every print rule behind it keeps them inert on routes
    // that do not render a report — see the note above that block.
    <div className="space-y-4" data-print-report>
      {/* Print-only masthead. On screen the page already has a heading and
          chrome; on paper the reader needs to know what this is, whose it is,
          and when it was produced. */}
      <div className="hidden print:block" data-testid="weekly-results-print-header">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em]">Aries AI</p>
        <h2 className="mt-1 text-xl font-semibold">Weekly results — {report.week.label}</h2>
        <p className="mt-1 text-xs">
          {report.week.startYmd} to {report.week.endYmd} · Generated{' '}
          {new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </p>
      </div>

      <ShellPanel
        eyebrow="This week"
        title={`Results for ${report.week.label}`}
        action={
          <button
            type="button"
            onClick={print}
            data-print-hidden
            data-testid="weekly-results-print-button"
            className="print-hidden inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.1]"
          >
            Print / Save as PDF
          </button>
        }
      >
        <p className="max-w-3xl text-sm leading-7 text-white/65">{summaryLine}</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <CountCard label="Published" value={report.published.total} detail={channelDetail(report)} />
          <CountCard label="Skipped" value={report.skipped.total} detail={report.skipped.note} />
          <CountCard
            label="Blocked"
            value={report.blocked.total}
            detail={
              report.blocked.reconnect
                ? 'A channel connection needs reauthorizing.'
                : 'Dispatches that ended in a failure.'
            }
            tone={report.blocked.total > 0 ? 'watch' : 'default'}
            action={
              report.blocked.reconnect ? (
                <Link
                  href="/dashboard/settings/channel-integrations"
                  data-print-hidden
                  className="print-hidden mt-3 inline-flex items-center rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/20"
                >
                  Reconnect Meta
                </Link>
              ) : null
            }
          />
        </div>

        {report.needsReconciliation.total > 0 ? (
          <p className="mt-4 text-sm leading-7 text-white/55">
            {report.needsReconciliation.total} post
            {report.needsReconciliation.total === 1 ? '' : 's'} awaiting manual confirmation — the
            platform never confirmed the outcome, so they may or may not have gone live.
          </p>
        ) : null}

        <div className="mt-5 border-t border-white/8 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
            Top channel
          </p>
          <p className="mt-1 text-white/80">
            {report.topChannel.channel
              ? `${titleCase(report.topChannel.channel)} — ${report.topChannel.value.toLocaleString('en-US')} ${
                  report.topChannel.basis === 'reach' ? 'reach' : 'posts published'
                }`
              : 'No posts published this week'}
          </p>
          {report.topChannel.channel ? (
            <p className="mt-1 text-xs text-white/45">
              {report.topChannel.basis === 'reach' ? 'Ranked by reach' : 'Ranked by posts published'}
            </p>
          ) : null}
        </div>
      </ShellPanel>

      <ShellPanel eyebrow="Performance" title="Best and weakest post">
        {report.bestPost.available || report.weakestPost.available ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <RankedPostCard label="Best post" slot={report.bestPost} />
            <RankedPostCard label="Weakest post" slot={report.weakestPost} />
          </div>
        ) : (
          <EmptyStatePanel
            compact
            title={
              report.bestPost.reason === 'no_posts_in_window'
                ? 'No posts to rank this week'
                : 'Engagement ranking isn’t available yet'
            }
            description={
              report.bestPost.reason === 'no_posts_in_window'
                ? 'Nothing published in this window, so there is no best or weakest post to show.'
                : 'Connect an account so Aries can rank posts by real engagement. Until then it will not guess a winner.'
            }
          />
        )}
      </ShellPanel>

      <ShellPanel eyebrow="What Aries learned" title="Recommended next week">
        <div className="space-y-3">
          {report.learnings.map((learning) => (
            <div
              key={learning.id}
              className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-5 py-4"
            >
              <p className="text-sm font-semibold text-white">{learning.title}</p>
              <p className="mt-1 text-sm leading-7 text-white/60">{learning.body}</p>
            </div>
          ))}
        </div>

        {report.nextAction ? (
          <div className="mt-4 rounded-[1.25rem] border border-white/14 bg-white/[0.06] px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
              Recommended next week
            </p>
            <p className="mt-1 text-sm font-semibold text-white">{report.nextAction.title}</p>
            <p className="mt-1 text-sm leading-7 text-white/60">{report.nextAction.body}</p>
            {report.nextAction.href ? (
              <Link
                href={report.nextAction.href}
                data-print-hidden
                className="print-hidden mt-3 inline-flex items-center rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-sm font-medium text-white/80 transition hover:bg-white/[0.1]"
              >
                Take me there
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-7 text-white/55">
            No adjustments recommended this week.
          </p>
        )}
      </ShellPanel>
    </div>
  );
}

function channelDetail(report: WeeklyResultsReportShape): string {
  const entries = Object.entries(report.published.byChannel);
  if (entries.length === 0) return 'No posts published this week.';
  return entries.map(([channel, n]) => `${titleCase(channel)} ${n}`).join(' · ');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function CountCard(props: {
  label: string;
  value: number;
  detail: string;
  tone?: 'default' | 'watch';
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
        {props.label}
      </p>
      <p
        className={`mt-1 text-3xl font-semibold ${
          props.tone === 'watch' ? 'text-amber-200' : 'text-white'
        }`}
      >
        {props.value}
      </p>
      <p className="mt-1 text-xs leading-6 text-white/50">{props.detail}</p>
      {props.action}
    </div>
  );
}

function RankedPostCard({ label, slot }: { label: string; slot: RankedSlot }) {
  return (
    <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">{label}</p>
      {slot.available && slot.post ? (
        <>
          <p className="mt-1 text-sm font-semibold text-white">
            {slot.post.title ?? `${titleCase(slot.post.platform)} post`}
          </p>
          <p className="mt-1 text-sm text-white/60">{slot.post.metricLabel}</p>
          {slot.post.permalink ? (
            <a
              href={slot.post.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-sm text-white/70 underline underline-offset-4 hover:text-white"
            >
              View on {titleCase(slot.post.platform)}
            </a>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-sm leading-7 text-white/55">Not available for this week.</p>
      )}
    </div>
  );
}
