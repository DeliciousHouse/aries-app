import Link from 'next/link';

import { ARIES_REVIEW_ITEMS } from './data';
import { EmptyStatePanel, ShellPanel, StatusChip } from './components';

export default function AriesReviewQueueScreen() {
  if (ARIES_REVIEW_ITEMS.length === 0) {
    return (
      <EmptyStatePanel
        title="You are clear for now"
        description="New review items will appear here when something needs your decision."
      />
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Review Queue" title="Everything that needs a decision">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Use this queue to approve, request changes, or reject anything that could affect a launch.
          Every item stays visible until the decision is complete.
        </p>
      </ShellPanel>

      <div className="grid gap-4">
        {ARIES_REVIEW_ITEMS.map((item) => (
          <Link
            key={item.id}
            href={`/review/${item.id}`}
            className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-5 transition hover:border-white/16 hover:bg-white/[0.06]"
          >
            <div className="grid gap-5 lg:grid-cols-[1.25fr_0.85fr_0.75fr]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold text-white">{item.title}</h2>
                  <StatusChip status={item.status} />
                </div>
                <p className="text-sm leading-7 text-white/60">{item.summary}</p>
              </div>
              <div className="space-y-2 text-sm text-white/62">
                <InfoRow label="Campaign" value={item.campaignName} />
                <InfoRow label="Placement" value={`${item.channel} · ${item.placement}`} />
              </div>
              <div className="space-y-2 text-sm text-white/62">
                <InfoRow label="Scheduled for" value={item.scheduledFor} />
                <InfoRow label="Version" value={item.currentVersion.label} />
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
