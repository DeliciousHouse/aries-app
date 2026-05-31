'use client';

import Link from 'next/link';

import { useRuntimePosts } from '@/hooks/use-runtime-social-content';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesResultsScreen() {
  const campaigns = useRuntimePosts({ autoLoad: true });
  const liveCampaigns = (campaigns.data?.posts ?? []).filter((campaign) => campaign.status === 'live');

  // Render the shell header immediately so the page looks alive while the
  // posts fetch hydrates (can take ~10-40s with many jobs).  The skeleton and
  // content area sit below the header rather than replacing the whole screen.
  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Results" title="Business-readable performance">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Results appear here after social content runs and real performance data is available.
        </p>
      </ShellPanel>

      {campaigns.isLoading ? (
        <LoadingStateGrid />
      ) : campaigns.error ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          {customerSafeUiErrorMessage(campaigns.error.message, 'Results are not available right now.')}
        </div>
      ) : liveCampaigns.length === 0 ? (
        <EmptyStatePanel
          title="Results will appear after posts run"
          description="Once posts are live and the system has real performance data, Aries will summarize what worked and suggest what to do next."
        />
      ) : (
        <>
          <ShellPanel eyebrow="Results" title="Live social content performance">
            <p className="max-w-3xl text-sm leading-7 text-white/65">
              These posts are currently live and have real performance activity behind them.
            </p>
          </ShellPanel>

          <div className="grid gap-4">
            {liveCampaigns.map((campaign) => (
              <Link key={campaign.id} href={`/dashboard/social-content/${campaign.id}`} className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-5 transition hover:border-white/16 hover:bg-white/[0.06]">
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
                    <InfoRow label="Current stage" value={campaign.stageLabel} />
                  </div>
                  <div className="space-y-3 text-sm text-white/62">
                    <InfoRow label="Next scheduled" value={campaign.nextScheduled} />
                    <InfoRow label="Updated" value={campaign.updatedAt || 'Unknown'} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">{props.label}</p>
      <p className="mt-1 text-white/80">{props.value}</p>
    </div>
  );
}
