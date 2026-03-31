'use client';

import Link from 'next/link';

import { useRuntimeReviews } from '@/hooks/use-runtime-reviews';

import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

function reviewTypeLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function AriesReviewQueueScreen() {
  const reviews = useRuntimeReviews({ autoLoad: true });
  const items = reviews.data?.reviews ?? [];

  if (reviews.isLoading) {
    return <LoadingStateGrid />;
  }

  if (reviews.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {reviews.error.message}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyStatePanel
        title="You are clear for now"
        description="New review items will appear here when something needs a decision."
      />
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Review Queue" title="Everything that needs a decision">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          This queue reflects the persisted campaign workflow. Brand review, strategy review, creative assets, and explicit workflow approvals all stay visible here until the decision is complete.
        </p>
      </ShellPanel>

      <div className="grid gap-4">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/review/${item.id}`}
            className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-5 transition hover:border-white/16 hover:bg-white/[0.06]"
          >
            <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr_0.85fr]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold text-white">{item.title}</h2>
                  <StatusChip status={item.status} />
                </div>
                <p className="text-sm leading-7 text-white/60">{item.summary}</p>
              </div>
              <div className="space-y-2 text-sm text-white/62">
                <InfoRow label="Campaign" value={item.campaignName} />
                <InfoRow label="Type" value={reviewTypeLabel(item.reviewType)} />
                <InfoRow label="Placement" value={`${item.channel} · ${item.placement}`} />
              </div>
              <div className="space-y-2 text-sm text-white/62">
                <InfoRow label="Workflow state" value={reviewTypeLabel(item.workflowState)} />
                <InfoRow label="Current version" value={item.currentVersion.label} />
                <InfoRow label="Decision history" value={String(item.history.length)} />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-1 text-white/78">{props.value}</p>
    </div>
  );
}
