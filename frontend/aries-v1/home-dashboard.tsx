'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { CalendarClock, ChevronRight, ShieldCheck, Sparkles } from 'lucide-react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useLatestMarketingJob } from '@/hooks/use-latest-marketing-job';

import { getActiveCampaign, getHomeWorkspaceSnapshot, hydrateCampaignFromRuntime, hydrateChannelsFromRuntime } from './adapters';
import { getCampaignReviews, ARIES_REVIEW_ITEMS } from './data';
import {
  ActivityFeed,
  ApprovalCard,
  CampaignSummaryCard,
  ChannelHealthIndicator,
  KpiStrip,
  LoadingStateGrid,
  NextActionCard,
  RecommendationCard,
  ScheduleCard,
  ShellPanel,
  TrustRibbon,
} from './components';

export default function AriesHomeDashboard() {
  const workspace = getHomeWorkspaceSnapshot();
  const latestJob = useLatestMarketingJob({ autoLoad: true });
  const integrations = useIntegrations({ autoLoad: true });

  const activeCampaign = useMemo(
    () => hydrateCampaignFromRuntime(latestJob.data || null, workspace.activeCampaignId),
    [latestJob.data, workspace.activeCampaignId],
  );
  const reviewItems = useMemo(
    () => getCampaignReviews(activeCampaign.id).length > 0 ? getCampaignReviews(activeCampaign.id) : ARIES_REVIEW_ITEMS,
    [activeCampaign.id],
  );
  const liveIntegrations = integrations.data?.status === 'ok' ? integrations.data : null;
  const channels = useMemo(() => hydrateChannelsFromRuntime(liveIntegrations), [liveIntegrations]);

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-[2.5rem] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] px-6 py-6 shadow-[0_32px_120px_rgba(0,0,0,0.28)] md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-3">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">Home</p>
              <h2 className="text-4xl font-semibold tracking-[-0.03em] text-white">
                {workspace.businessName}
              </h2>
              <p className="max-w-2xl text-base leading-7 text-white/65">
                Aries is keeping your marketing simple: review what needs you, see what is scheduled next,
                and keep launches safe.
              </p>
            </div>
            <TrustRibbon />
          </div>
          <div className="mt-8">
            <KpiStrip items={workspace.resultsSummary} />
          </div>
        </div>

        <NextActionCard recommendation={workspace.nextAction} trustMessage={workspace.trustMessage} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <CampaignSummaryCard campaign={activeCampaign} />
        <div className="space-y-4">
          <ScheduleCard item={workspace.scheduledNext} />
          <ApprovalCard reviewItems={reviewItems} />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr_0.8fr]">
        <ShellPanel
          eyebrow="Working Now"
          title={activeCampaign.results.headline}
          action={
            <Link href="/results" className="inline-flex items-center gap-2 text-sm font-medium text-white/75 hover:text-white">
              Open results
              <ChevronRight className="h-4 w-4" />
            </Link>
          }
        >
          <div className="space-y-5">
            <p className="text-sm leading-7 text-white/65">{activeCampaign.results.summary}</p>
            <RecommendationCard recommendation={activeCampaign.recommendations[0]} />
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="This Week" title="What is scheduled next">
          <div className="space-y-4">
            {activeCampaign.schedule.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-[1.25rem] border border-white/8 bg-black/15 px-4 py-4"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium text-white">{item.title}</p>
                  <p className="text-sm text-white/50">{item.channel}</p>
                </div>
                <div className="text-right text-sm text-white/60">
                  <div className="inline-flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-white/40" />
                    {item.scheduledFor}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Channel Health" title="Connected surfaces">
          {integrations.isLoading ? (
            <LoadingStateGrid />
          ) : (
            <div className="space-y-3">
              {channels.slice(0, 3).map((channel) => (
                <ChannelHealthIndicator key={channel.id} channel={channel} />
              ))}
            </div>
          )}
        </ShellPanel>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_0.95fr]">
        <ShellPanel eyebrow="Recent Activity" title="What Aries has done recently">
          <ActivityFeed items={activeCampaign.activity} />
        </ShellPanel>
        <ShellPanel eyebrow="Confidence" title="Why this stays safe">
          <div className="space-y-4 text-sm leading-7 text-white/65">
            <div className="rounded-[1.4rem] border border-white/8 bg-black/15 px-4 py-4">
              <p className="font-medium text-white">Approval stays visible</p>
              <p className="mt-2">Any item that changed after approval moves back into review before scheduling continues.</p>
            </div>
            <div className="rounded-[1.4rem] border border-white/8 bg-black/15 px-4 py-4">
              <p className="font-medium text-white">Schedules are readable</p>
              <p className="mt-2">Aries shows exactly what is planned, when it is set to run, and what is waiting.</p>
            </div>
            <div className="rounded-[1.4rem] border border-white/8 bg-black/15 px-4 py-4">
              <p className="font-medium text-white">Results lead to action</p>
              <p className="mt-2">Every result summary ends with one recommended next move instead of a wall of analytics.</p>
            </div>
          </div>
        </ShellPanel>
      </section>

      <section className="rounded-[2rem] border border-dashed border-white/10 bg-black/10 px-6 py-5 text-sm text-white/60">
        <div className="flex flex-wrap items-center gap-3">
          <Sparkles className="h-4 w-4 text-white/50" />
          Build note: if the live marketing runtime returns richer campaign data, this home view can absorb it through the existing marketing and integrations adapters without changing the screen structure.
        </div>
      </section>
    </div>
  );
}
