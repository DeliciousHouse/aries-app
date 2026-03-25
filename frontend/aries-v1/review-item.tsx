'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, MessageSquareText, XCircle } from 'lucide-react';

import { getReviewItemById } from './data';
import {
  ShellPanel,
  StatusChip,
  VersionCompare,
} from './components';

type DecisionState = 'idle' | 'approved' | 'changes_requested' | 'rejected';

export default function AriesReviewItemScreen(props: { reviewId: string }) {
  const item = useMemo(() => getReviewItemById(props.reviewId), [props.reviewId]);
  const [decision, setDecision] = useState<DecisionState>('idle');

  const effectiveStatus =
    decision === 'approved'
      ? 'approved'
      : decision === 'changes_requested' || decision === 'rejected'
        ? 'changes_requested'
        : item.status;

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Review Item" title={item.title}>
        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status={effectiveStatus} />
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
          </div>
        </div>
      </ShellPanel>

      <VersionCompare
        currentVersion={item.currentVersion}
        previousVersion={item.previousVersion}
      />

      <ShellPanel eyebrow="What changed" title="Version notes">
        <div className="grid gap-4 lg:grid-cols-2">
          <VersionNotes title={item.currentVersion.label} notes={item.currentVersion.notes} />
          {item.previousVersion ? (
            <VersionNotes title={item.previousVersion.label} notes={item.previousVersion.notes} />
          ) : null}
        </div>
      </ShellPanel>

      <ShellPanel eyebrow="Decision" title="Choose what happens next">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setDecision('approved')}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c]"
          >
            <CheckCircle2 className="h-4 w-4" />
            Approve
          </button>
          <button
            type="button"
            onClick={() => setDecision('changes_requested')}
            className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white"
          >
            <MessageSquareText className="h-4 w-4" />
            Request changes
          </button>
          <button
            type="button"
            onClick={() => setDecision('rejected')}
            className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-300/10 px-5 py-3 text-sm font-semibold text-rose-50"
          >
            <XCircle className="h-4 w-4" />
            Reject
          </button>
        </div>

        {decision !== 'idle' ? (
          <div className="mt-5 rounded-[1.4rem] border border-white/10 bg-black/15 px-4 py-4 text-sm text-white/70">
            {decision === 'approved'
              ? 'Approved. Aries can keep this item in the launch schedule without exposing any internal workflow detail.'
              : decision === 'changes_requested'
                ? 'Changes requested. This item should visually return to needs-review before it can be scheduled again.'
                : 'Rejected. The campaign can still move forward, but this specific item should not be launched.'}
          </div>
        ) : null}
      </ShellPanel>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/review"
          className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white"
        >
          Back to queue
        </Link>
        <Link
          href={`/campaigns/${item.campaignId}`}
          className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white"
        >
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
      <ul className="mt-3 space-y-2 text-sm leading-7 text-white/60">
        {props.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
