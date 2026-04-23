'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, LoaderCircle, MessageSquareText, XCircle } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { useRuntimeReviewItem } from '@/hooks/use-runtime-review-item';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { getReviewRecoveryState } from './review-recovery';
import { isDestructiveActionBlocked } from './review-destructive-guard';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

type DecisionActionKind = 'approve' | 'changes_requested' | 'reject';

const DECISION_PROGRESS_LABELS: Record<DecisionActionKind, string[]> = {
  approve: ['Saving decision', 'Resuming workflow', 'Preparing next stage', 'Loading review'],
  changes_requested: ['Saving request', 'Sending revision notes', 'Updating review state', 'Refreshing checkpoint'],
  reject: ['Saving decision', 'Marking review rejected', 'Updating review state', 'Refreshing checkpoint'],
};

function workflowLabel(value: string): string {
  if (value === 'workflow_approval') {
    return 'Approval';
  }
  if (value === 'brand') {
    return 'Brand direction';
  }
  if (value === 'strategy') {
    return 'Campaign strategy';
  }
  if (value === 'creative') {
    return 'Creative approval';
  }
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function visibleActorLabel(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }
  if (['operator', 'system', 'workflow', 'automation'].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

function chipStatus(value: string): 'draft' | 'in_review' | 'approved' | 'scheduled' | 'live' | 'changes_requested' | 'rejected' {
  if (value === 'approved') return 'approved';
  if (value === 'changes_requested') return 'changes_requested';
  if (value === 'rejected') return 'rejected';
  return 'in_review';
}

function brandKitFontStyle(family: string): CSSProperties {
  return {
    fontFamily: `"${family}", ${family}, ui-sans-serif, system-ui, sans-serif`,
  };
}

export default function AriesReviewItemScreen(props: { reviewId: string }) {
  const review = useRuntimeReviewItem(props.reviewId, { autoLoad: true });
  const item = review.data?.review ?? null;
  const recoveryState = getReviewRecoveryState(review.error);
  const [note, setNote] = useState('');
  const [activeAction, setActiveAction] = useState<DecisionActionKind>('approve');
  const [progressIndex, setProgressIndex] = useState(0);
  const busy = review.decision.isLoading;
  // Synchronous double-submit lock. `busy` / `disabled` aren't enough because
  // React state updates are async — a fast second click or effect re-invocation
  // can fire before `setLoading()` flips `busy`. We hit this during live testing
  // where a single user click produced two approval POSTs and the pipeline
  // advanced two gates at once, skipping the launch-review surface entirely.
  const submittingRef = useRef(false);
  const lastSubmitAt = useRef(0);

  const decisionSummary = useMemo(() => {
    if (!item?.lastDecision) return null;
    const actor = visibleActorLabel(item.lastDecision.actedBy);
    const action = item.lastDecision.action.replace(/_/g, ' ');
    const timestamp = new Date(item.lastDecision.at).toLocaleString();
    return actor ? `${action} by ${actor} at ${timestamp}` : `${action} at ${timestamp}`;
  }, [item]);

  useEffect(() => {
    if (!busy) {
      setProgressIndex(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setProgressIndex((current) => Math.min(current + 1, DECISION_PROGRESS_LABELS[activeAction].length - 1));
    }, 1800);

    return () => window.clearInterval(intervalId);
  }, [activeAction, busy]);

  if (review.isLoading) {
    return <LoadingStateGrid />;
  }

  if (review.error) {
    if (recoveryState) {
      return (
        <EmptyStatePanel
          title={recoveryState.title}
          description={`${recoveryState.description} ${recoveryState.guidance}`}
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href={recoveryState.primaryAction.href}
                className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
              >
                {recoveryState.primaryAction.label}
              </Link>
              <Link
                href={recoveryState.secondaryAction.href}
                className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-medium text-white/80 transition hover:border-white/20 hover:text-white"
              >
                {recoveryState.secondaryAction.label}
              </Link>
            </div>
          }
        />
      );
    }

    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(review.error.message, 'This review item is not available right now.')}
      </div>
    );
  }

  if (!item) {
    return <EmptyStatePanel title="Review item not found" description="This review item could not be loaded from the current runtime state." />;
  }

  const reviewItem = item;
  const activeProgressLabel = busy ? DECISION_PROGRESS_LABELS[activeAction][progressIndex] : null;
  const noteIsEmpty = note.trim().length === 0;

  async function applyDecision(action: 'approve' | 'changes_requested' | 'reject') {
    // Destructive actions require a non-empty comment so the actor provides
    // rationale that flows into decision history. Reject additionally prompts
    // a confirm() so a misclick doesn't terminate the review.
    if ((action === 'changes_requested' || action === 'reject') && isDestructiveActionBlocked(action, note)) {
      return;
    }
    if (action === 'reject' && typeof window !== 'undefined') {
      const confirmed = window.confirm('Reject this review? This cannot be undone from the client side.');
      if (!confirmed) {
        return;
      }
    }
    // Bug A hardening: the ref lock alone doesn't catch a second click that
    // fires after the first POST resolves but before the component re-renders
    // (observed on approve_stage_4_publish where the first POST returns 200
    // and a duplicate follow-up hits the gateway lock for ~4s). A 1s floor
    // between submits at the same call site is a cheap belt-and-suspenders.
    const now = Date.now();
    if (submittingRef.current || now - lastSubmitAt.current < 1000) return;
    submittingRef.current = true;
    lastSubmitAt.current = now;
    try {
      const approvalId =
        reviewItem.reviewType === 'workflow_approval' && reviewItem.currentVersion.id.startsWith('approval:')
          ? reviewItem.currentVersion.id.slice('approval:'.length)
          : undefined;
      await review.submitDecision({
        action,
        actedBy: 'Client reviewer',
        note,
        approvalId,
      });
      setNote('');
    } finally {
      submittingRef.current = false;
    }
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
            </div>
            <p className="text-sm leading-7 text-white/65">{reviewItem.summary}</p>
            </div>
            <div className="rounded-[1.5rem] border border-white/8 bg-black/15 px-5 py-5 text-sm leading-7 text-white/65">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">What this decision does</p>
            <p className="mt-3">
              {reviewItem.reviewType === 'workflow_approval'
                ? 'Approving this clears the current approval and opens the next prepared stage. Requesting changes keeps this package open for revision.'
                : 'Approving this confirms the current package. Requesting changes keeps this stage open until revisions are ready.'}
            </p>
            {decisionSummary ? <p className="mt-3 text-white/55">Last decision: {decisionSummary}</p> : null}
          </div>
        </div>
      </ShellPanel>

      {reviewItem.previewUrl || reviewItem.fullPreviewUrl ? (
        <>
          {reviewItem.contentType?.startsWith('video/') ? (
            <ShellPanel eyebrow="Preview" title="Video preview">
              <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                <MediaPreview
                  src={reviewItem.fullPreviewUrl || reviewItem.previewUrl || null}
                  alt={reviewItem.title}
                  contentType={reviewItem.contentType || null}
                  href={reviewItem.fullPreviewUrl || reviewItem.previewUrl || null}
                  className="min-h-[24rem] overflow-hidden rounded-[1.2rem] border border-white/8 bg-black/20"
                  imageClassName="h-full w-full object-contain bg-black"
                  emptyLabel="Preview pending"
                  nonImageLabel="Open video"
                />
                <div className="space-y-4">
                  <p className="text-sm leading-7 text-white/65">
                    The rendered video plays inline. Use the full-preview link to open it in a new tab.
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
          ) : (
            <ShellPanel eyebrow="Preview" title="Full preview access">
              <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                <MediaPreview
                  src={reviewItem.fullPreviewUrl || reviewItem.previewUrl || null}
                  alt={reviewItem.title}
                  contentType={reviewItem.contentType || null}
                  href={reviewItem.fullPreviewUrl || reviewItem.previewUrl || null}
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
          )}
        </>
      ) : null}

      {reviewItem.sections.length > 0 ? (
        <div className="grid gap-4">
          {reviewItem.sections.map((section) => (
            <ShellPanel key={section.id} eyebrow="Content" title={section.title}>
              <div className="space-y-5">
                <div className="whitespace-pre-wrap text-sm leading-7 text-white/68">{section.body}</div>

                {section.brandKitVisuals ? (
                  <div className="space-y-5 border-t border-white/8 pt-5">
                    {section.brandKitVisuals.logos.length > 0 ? (
                      <div className="space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Visible marks</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {section.brandKitVisuals.logos.map((logoUrl, index) => (
                            <div
                              key={`${section.id}-logo-${index}`}
                              className="overflow-hidden rounded-[1.1rem] border border-white/8 px-4 py-4"
                              style={{
                                backgroundColor: '#2a2a2a',
                                backgroundImage:
                                  'linear-gradient(45deg, #222 25%, transparent 25%), linear-gradient(-45deg, #222 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #222 75%), linear-gradient(-45deg, transparent 75%, #222 75%)',
                                backgroundSize: '20px 20px',
                                backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
                              }}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={logoUrl} alt={`${section.title} logo ${index + 1}`} className="h-24 w-full object-contain" />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {section.brandKitVisuals.colors.length > 0 ? (
                      <div className="space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Palette cues</p>
                        <div className="grid gap-3 sm:grid-cols-3">
                          {section.brandKitVisuals.colors.map((color) => (
                            <div key={`${section.id}-${color.hex}`} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-3">
                              <div className="h-16 rounded-[0.9rem] border border-white/10" style={{ backgroundColor: color.hex }} />
                              <p className="mt-3 text-sm font-medium text-white">{color.label}</p>
                              <p className="text-xs uppercase tracking-[0.14em] text-white/55">{color.hex}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {section.brandKitVisuals.fonts.length > 0 ? (
                      <div className="space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Typography cues</p>
                        <div className="grid gap-3">
                          {section.brandKitVisuals.fonts.map((font) => (
                            <div key={`${section.id}-${font.family}`} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-4">
                              <p className="text-xs uppercase tracking-[0.14em] text-white/45">{font.label}</p>
                              <p className="mt-3 text-2xl text-white" style={brandKitFontStyle(font.family)}>
                                {font.sampleText}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </ShellPanel>
          ))}
        </div>
      ) : null}

      <div className="space-y-4">
        <ShellPanel eyebrow="Decision" title="Choose what happens next">
          <div className="space-y-4">
            <div>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, 600))}
                placeholder={reviewItem.notePlaceholder || 'Share any revision context for the team'}
                className="w-full rounded-[1.25rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-white placeholder:text-white/30"
                maxLength={600}
                aria-describedby="note-char-count"
              />
              <p id="note-char-count" className={`mt-1.5 text-right text-xs tabular-nums ${note.length >= 550 ? 'text-amber-400/70' : 'text-white/30'}`}>
                {note.length} / 600
              </p>
              {noteIsEmpty ? (
                <p className="mt-1.5 text-xs text-white/45" data-testid="destructive-note-helper">
                  A comment is required to request changes.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setActiveAction('approve');
                  void applyDecision('approve');
                }}
                disabled={busy}
                /* Inline color is a cascade-proof belt-and-suspenders for
                   the approval CTA so the label is always visible on the
                   white pill even if utility layering shifts elsewhere. */
                style={{ color: '#11161c' }}
                className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-60"
              >
                {busy && activeAction === 'approve' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {busy && activeAction === 'approve' ? activeProgressLabel : reviewItem.currentVersion.cta || 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveAction('changes_requested');
                  void applyDecision('changes_requested');
                }}
                disabled={busy || noteIsEmpty}
                aria-disabled={busy || noteIsEmpty}
                data-testid="review-request-changes"
                title={noteIsEmpty ? 'A comment is required to request changes.' : undefined}
                className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy && activeAction === 'changes_requested' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
                {busy && activeAction === 'changes_requested' ? activeProgressLabel : 'Request changes'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveAction('reject');
                  void applyDecision('reject');
                }}
                disabled={busy || noteIsEmpty}
                aria-disabled={busy || noteIsEmpty}
                data-testid="review-reject"
                title={noteIsEmpty ? 'A comment is required to reject.' : undefined}
                className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-300/10 px-5 py-3 text-sm font-semibold text-rose-50 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy && activeAction === 'reject' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                {busy && activeAction === 'reject' ? activeProgressLabel : 'Reject'}
              </button>
            </div>
          </div>
        </ShellPanel>
      </div>

      <ShellPanel eyebrow="History" title="Decision history">
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
                        {[visibleActorLabel(entry.actor), new Date(entry.at).toLocaleString()].filter(Boolean).join(' · ')}
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
