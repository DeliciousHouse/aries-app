'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, MessageSquareText, XCircle } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { useRuntimeReviewItem } from '@/hooks/use-runtime-review-item';

import { EmptyStatePanel, ShellPanel, StatusChip } from './components';

function workflowLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function chipStatus(value: string): 'draft' | 'in_review' | 'approved' | 'scheduled' | 'live' | 'changes_requested' | 'rejected' {
  if (value === 'approved') return 'approved';
  if (value === 'changes_requested') return 'changes_requested';
  if (value === 'rejected') return 'rejected';
  return 'in_review';
}

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
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading review item...</div>;
  }

  if (review.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{review.error.message}</div>;
  }

  if (!item) {
    return <EmptyStatePanel title="Review item not found" description="This review item could not be loaded from the current runtime state." />;
  }

  const reviewItem = item;

  async function applyDecision(action: 'approve' | 'changes_requested' | 'reject') {
    const approvalId =
      reviewItem.reviewType === 'workflow_approval' && reviewItem.currentVersion.id.startsWith('approval:')
        ? reviewItem.currentVersion.id.slice('approval:'.length)
        : undefined;
    await review.submitDecision({
      action,
      actedBy: 'operator',
      note,
      approvalId,
    });
    setNote('');
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow={workflowLabel(reviewItem.reviewType)} title={reviewItem.title}>
        <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status={reviewItem.status} />
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                {reviewItem.channel} · {reviewItem.placement}
              </span>
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                {workflowLabel(reviewItem.workflowState)}
              </span>
            </div>
            <p className="text-sm leading-7 text-white/65">{reviewItem.summary}</p>
          </div>
          <div className="rounded-[1.5rem] border border-white/8 bg-black/15 px-5 py-5 text-sm leading-7 text-white/65">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Decision guidance</p>
            <p className="mt-3">
              {reviewItem.reviewType === 'workflow_approval'
                ? 'Approving resumes the underlying workflow. Request changes only records feedback. Rejecting explicitly denies the checkpoint.'
                : 'Approving records this review as complete. Requesting changes keeps publish gated until a new revision is ready.'}
            </p>
            {decisionSummary ? <p className="mt-3 text-white/55">Last decision: {decisionSummary}</p> : null}
          </div>
        </div>
      </ShellPanel>

      {reviewItem.previewUrl || reviewItem.fullPreviewUrl ? (
        <ShellPanel eyebrow="Preview" title="Full preview access">
          <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
            <MediaPreview
              src={reviewItem.fullPreviewUrl || reviewItem.previewUrl || null}
              alt={reviewItem.title}
              contentType={reviewItem.contentType || null}
              className="min-h-[24rem] overflow-hidden rounded-[1.2rem] border border-white/8 bg-black/20"
              imageClassName="h-full w-full object-contain bg-black/40"
              emptyLabel="Preview pending"
              nonImageLabel="Preview available"
            />
            <div className="space-y-4">
              <p className="text-sm leading-7 text-white/65">
                Use the full-preview action to open the asset without the shallow dashboard crop.
              </p>
              {reviewItem.fullPreviewUrl ? (
                <a href={reviewItem.fullPreviewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:border-white/20 hover:text-white">
                  Open full preview
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              ) : null}
              {reviewItem.destinationUrl ? (
                <a href={reviewItem.destinationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/80 transition hover:border-white/20 hover:text-white">
                  Open destination
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              ) : null}
            </div>
          </div>
        </ShellPanel>
      ) : null}

      {reviewItem.sections.length > 0 ? (
        <div className="grid gap-4">
          {reviewItem.sections.map((section) => (
            <ShellPanel key={section.id} eyebrow="Content" title={section.title}>
              <div className="whitespace-pre-wrap text-sm leading-7 text-white/68">{section.body}</div>
            </ShellPanel>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <ShellPanel eyebrow="Attachments" title="Supporting artifacts">
          {reviewItem.attachments.length === 0 ? (
            <p className="text-sm text-white/55">No supporting artifacts were attached to this review item.</p>
          ) : (
            <div className="space-y-3">
              {reviewItem.attachments.map((attachment) => (
                <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 text-sm text-white/80 transition hover:border-white/16 hover:text-white">
                  <span>{attachment.label}</span>
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              ))}
            </div>
          )}
        </ShellPanel>

        <ShellPanel eyebrow="Decision" title="Choose what happens next">
          <div className="space-y-4">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 600))}
              placeholder={reviewItem.notePlaceholder || 'Add context for the team'}
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
                {busy ? 'Saving...' : reviewItem.reviewType === 'workflow_approval' ? 'Approve and resume' : 'Approve'}
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
      </div>

      <ShellPanel eyebrow="History" title="Decision trail">
        {reviewItem.history.length === 0 ? (
          <p className="text-sm text-white/55">No decision history yet.</p>
        ) : (
          <div className="space-y-3">
            {reviewItem.history
              .slice()
              .sort((left, right) => right.at.localeCompare(left.at))
              .map((entry) => (
                <div key={entry.id} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">{workflowLabel(entry.type)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        {entry.actor} · {new Date(entry.at).toLocaleString()}
                      </p>
                    </div>
                    <StatusChip status={chipStatus(entry.status || '')}>
                      {entry.status ? workflowLabel(entry.status) : workflowLabel(entry.workflowState)}
                    </StatusChip>
                  </div>
                  {entry.note ? <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white/60">{entry.note}</p> : null}
                </div>
              ))}
          </div>
        )}
      </ShellPanel>

      <div className="flex flex-wrap items-center gap-3">
        <Link href="/review" className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white">
          Back to queue
        </Link>
        <Link href={`/dashboard/campaigns/${item.campaignId}`} className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white">
          Open campaign
        </Link>
      </div>
    </div>
  );
}
