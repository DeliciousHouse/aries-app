'use client';

import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';

import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';

import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesCampaignListScreen() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const items = campaigns.data?.campaigns ?? [];

  if (campaigns.isLoading) {
    return <LoadingStateGrid />;
  }

  if (campaigns.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{campaigns.error.message}</div>;
  }

  if (items.length === 0) {
    return (
      <EmptyStatePanel
        title="No campaigns yet"
        description="Aries will turn your business and goals into a review-ready marketing plan once you create your first campaign."
        action={
          <Link href="/onboarding/start" className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c]">
            Create first campaign
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel
        eyebrow="Campaigns"
        title="Every campaign in one place"
        action={
          <Link href="/onboarding/start" className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-[#11161c]">
            <Plus className="h-4 w-4" />
            New campaign
          </Link>
        }
      >
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Review the current state of each campaign, open what needs attention, and jump directly into review, schedule, or results.
        </p>
      </ShellPanel>

      <div className="grid gap-4">
        {items.map((campaign) => (
          <Link
            key={campaign.id}
            href={`/campaigns/${campaign.id}`}
            className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-5 transition hover:border-white/16 hover:bg-white/[0.06]"
          >
            <div className="grid gap-5 lg:grid-cols-[1.3fr_0.9fr_0.8fr]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-semibold text-white">{campaign.name}</h2>
                  <StatusChip status={campaign.status} />
                </div>
                <p className="text-sm leading-7 text-white/62">{campaign.summary}</p>
              </div>

              <div className="space-y-3 text-sm text-white/62">
                <InfoRow label="Objective" value={campaign.objective} />
                <InfoRow label="Window" value={campaign.dateRange} />
                <InfoRow label="Next scheduled" value={campaign.nextScheduled} />
              </div>

              <div className="space-y-3 text-sm text-white/62">
                <InfoRow label="Pending approvals" value={String(campaign.pendingApprovals)} />
                <InfoRow label="Current stage" value={campaign.stageLabel} />
                <div className="inline-flex items-center gap-2 text-sm font-medium text-white">
                  Open workspace
                  <ArrowRight className="h-4 w-4" />
                </div>
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
      <p className="mt-1 text-white/80">{props.value}</p>
    </div>
  );
}
