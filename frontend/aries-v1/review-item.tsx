'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, MessageSquareText, XCircle } from 'lucide-react';

import { useRuntimeReviewItem } from '@/hooks/use-runtime-review-item';

import { EmptyStatePanel, ShellPanel, StatusChip, VersionCompare } from './components';

export default function AriesReviewItemScreen(props: { reviewId: string }) {
  const review = useRuntimeReviewItem(props.reviewId, { autoLoad: true });
  const item = review.data?.review ?? null;
  const [note, setNote] = useState('');

  const busy = review.decision.isLoading;

  const decisionSummary = useMemo(() => {
    if (!item?.lastDecision) return null;
    return `${item.lastDecision.action.replace(/_/g, ' ')} by ${item.lastDecision.actedBy} at ${new Date(item.lastDecision.at).toLocaleString()}`;
  }, [item]);

  if (review.isLoading) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading review item…</div>;
  }

  if (review.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{review.error.message}</div>;
  }

  if (!item) {
    return <EmptyStatePanel title="Review item not found" description="This review item could not be loaded from the current runtime state." />;
  }

  async function applyDecision(action: 'approve' | 'changes_requested' | 'reject') {
    await review.submitDecision({
      action,
      actedBy: 'operator',
      note,
    });
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Review Item" title={item.title}>
        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status={item.status} />
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                {item.channel} · {item.placement}
              </span>
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                {item.scheduledFor}
              </span>
            </div>
            <p className="text-sm leading-7 text-white/65">{item.summary}</p>
          </div>
          <div className="rounded-[1.5rem] border border-white/8 bg-black/15 px-5 py-5 text-sm leading-7 text-white/65">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Decision guidance</p>
            <p className="mt-3">
              Approving keeps the item eligible for scheduling. Requesting changes returns it to review before launch.
            </p>
            {decisionSummary ? <p className="mt-3 text-white/55">Last decision: {decisionSummary}</p> : null}
          </div>
        </div>
      </ShellPanel>

      <VersionCompare currentVersion={item.currentVersion} previousVersion={item.previousVersion} />

      <ShellPanel eyebrow="What changed" title="Version notes">
        <VersionNotes title={item.currentVersion.label} notes={item.currentVersion.notes} />
      </ShellPanel>

      <ShellPanel eyebrow="Decision" title="Choose what happens next">
        <div className="space-y-4">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 400))}
            placeholder="Add context for the team (optional)"
            className="w-full rounded-[1.25rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-white placeholder:text-white/30"
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void applyDecision('approve')}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" />
              {busy ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => void applyDecision('changes_requested')}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              <MessageSquareText className="h-4 w-4" />
              Request changes
            </button>
            <button
              type="button"
              onClick={() => void applyDecision('reject')}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-300/10 px-5 py-3 text-sm font-semibold text-rose-50 disabled:opacity-60"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
          </div>
        </div>
      </ShellPanel>

      <div className="flex flex-wrap items-center gap-3">
        <Link href="/review" className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white">
          Back to queue
        </Link>
        <Link href={`/campaigns/${item.campaignId}`} className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white">
          Open campaign
        </Link>
      </div>
    </div>
  );
}

function VersionNotes(props: { title: string; notes: string[] }) {
  return (
    <div className="rounded-[1.4rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-sm font-medium text-white">{props.title}</p>
      {props.notes.length === 0 ? (
        <p className="mt-3 text-sm text-white/55">No detailed notes were provided for this version.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm leading-7 text-white/60">
          {props.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
