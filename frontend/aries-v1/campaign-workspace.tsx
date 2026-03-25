'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronDown } from 'lucide-react';

import { getCampaignById, getCampaignReviews } from './data';
import {
  ActivityFeed,
  AssetGallery,
  CampaignStageRail,
  EmptyStatePanel,
  KpiStrip,
  PublishReceipt,
  RecommendationCard,
  ScheduleComposer,
  SectionLink,
  ShellPanel,
  StatusChip,
} from './components';

const tabs = ['Overview', 'Plan', 'Creative', 'Schedule', 'Results'] as const;

export default function AriesCampaignWorkspace(props: { campaignId: string }) {
  const campaign = useMemo(() => getCampaignById(props.campaignId), [props.campaignId]);
  const reviewItems = useMemo(() => getCampaignReviews(campaign.id), [campaign.id]);
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('Overview');
  const [showActivity, setShowActivity] = useState(false);

  return (
    <div className="space-y-6">
      <ShellPanel eyebrow="Campaign" title={campaign.name}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={campaign.status} />
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {campaign.dateRange}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {campaign.objective}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-7 text-white/65">{campaign.summary}</p>
          <CampaignStageRail campaign={campaign} />
        </div>
      </ShellPanel>

      <div className="flex flex-wrap gap-3">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-full border px-4 py-2.5 text-sm font-medium transition ${
              activeTab === tab
                ? 'border-white/20 bg-white/[0.08] text-white'
                : 'border-white/8 bg-white/[0.03] text-white/55 hover:border-white/15 hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Overview' ? (
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <ShellPanel eyebrow="Overview" title="What is happening now">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard label="Objective" value={campaign.objective} />
              <InfoCard label="Current stage" value={campaign.stageLabel} />
              <InfoCard label="Pending approvals" value={String(campaign.pendingApprovals)} />
              <InfoCard label="Next scheduled" value={campaign.nextScheduled} />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <SectionLink href="/review" label="Open review queue" />
              <SectionLink href="/calendar" label="Open calendar" />
              <SectionLink href="/results" label="See results" />
            </div>
          </ShellPanel>

          <ShellPanel eyebrow="Recommended" title={campaign.recommendations[0]?.title || 'No recommendation yet'}>
            {campaign.recommendations[0] ? (
              <RecommendationCard recommendation={campaign.recommendations[0]} />
            ) : (
              <EmptyStatePanel
                compact
                title="Recommendations will appear here"
                description="Once Aries sees enough movement, it will suggest the next best action."
              />
            )}
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Plan' ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <ShellPanel eyebrow="Plan" title="Campaign summary">
            <div className="space-y-5 text-sm leading-7 text-white/68">
              <PlanRow label="Goal" value={campaign.plan.goal} />
              <PlanRow label="Audience" value={campaign.plan.audience} />
              <PlanRow label="Message" value={campaign.plan.message} />
              <PlanRow label="Offer" value={campaign.plan.offer} />
              <PlanRow label="Why now" value={campaign.plan.whyNow} />
            </div>
          </ShellPanel>
          <ShellPanel eyebrow="Channels" title="Where this campaign will run">
            <div className="space-y-4">
              {campaign.plan.channels.map((channel) => (
                <div
                  key={channel}
                  className="rounded-[1.2rem] border border-white/8 bg-black/12 px-4 py-4 text-sm text-white/75"
                >
                  {channel}
                </div>
              ))}
            </div>
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Creative' ? (
        <div className="space-y-4">
          <ShellPanel eyebrow="Creative" title={campaign.creative.heroTitle}>
            <p className="max-w-3xl text-sm leading-7 text-white/65">{campaign.creative.summary}</p>
          </ShellPanel>
          <AssetGallery campaign={campaign} />
          {reviewItems.length > 0 ? (
            <ShellPanel eyebrow="Review" title="Items waiting on approval">
              <div className="space-y-3">
                {reviewItems.map((item) => (
                  <Link
                    key={item.id}
                    href={`/review/${item.id}`}
                    className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 transition hover:border-white/16"
                  >
                    <div>
                      <p className="text-sm font-medium text-white">{item.title}</p>
                      <p className="text-sm text-white/50">{item.channel} · {item.scheduledFor}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-white/50" />
                  </Link>
                ))}
              </div>
            </ShellPanel>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'Schedule' ? (
        <div className="space-y-4">
          <ShellPanel eyebrow="Schedule" title="Launch timing and visibility">
            <div className="space-y-4">
              <p className="max-w-3xl text-sm leading-7 text-white/65">
                Aries keeps every scheduled item readable and approval-safe. If something changes materially,
                it moves back into review before scheduling continues.
              </p>
              <ScheduleComposer items={campaign.schedule} />
              <PublishReceipt />
            </div>
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Results' ? (
        <div className="space-y-4">
          <ShellPanel eyebrow="Results" title={campaign.results.headline}>
            <p className="max-w-3xl text-sm leading-7 text-white/65">{campaign.results.summary}</p>
            <div className="mt-5">
              <KpiStrip items={campaign.results.kpis} />
            </div>
          </ShellPanel>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowActivity((current) => !current)}
        className="inline-flex items-center gap-2 text-sm font-medium text-white/70 transition hover:text-white"
      >
        {showActivity ? 'Hide activity history' : 'Show activity history'}
        <ChevronDown className={`h-4 w-4 transition ${showActivity ? 'rotate-180' : ''}`} />
      </button>

      {showActivity ? (
        <ShellPanel eyebrow="Activity" title="Recent changes and decisions">
          <ActivityFeed items={campaign.activity} />
        </ShellPanel>
      ) : null}
    </div>
  );
}

function InfoCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm text-white/78">{props.value}</p>
    </div>
  );
}

function PlanRow(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2">{props.value}</p>
    </div>
  );
}
