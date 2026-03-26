'use client';

import Link from 'next/link';
import { ChevronRight, Sparkles } from 'lucide-react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useBusinessProfile } from '@/hooks/use-business-profile';
import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';
import { useRuntimeReviews } from '@/hooks/use-runtime-reviews';

import { ChannelHealthIndicator, EmptyStatePanel, LoadingStateGrid, ReviewBadge, ShellPanel, StatusChip, TrustRibbon } from './components';
import type { RuntimeCampaignListItem } from '@/lib/api/aries-v1';

function nextActionFor(campaigns: RuntimeCampaignListItem[], reviewCount: number): {
  title: string;
  summary: string;
  href: string;
  label: string;
} {
  if (campaigns.length === 0) {
    return {
      title: 'Create your first campaign',
      summary: 'Aries will turn your business and goals into a campaign you can review before anything goes live.',
      href: '/onboarding/start',
      label: 'Create campaign',
    };
  }
  if (reviewCount > 0) {
    return {
      title: 'Review what is waiting',
      summary: `${reviewCount} item${reviewCount === 1 ? '' : 's'} need a decision before launch can continue.`,
      href: '/review',
      label: 'Review now',
    };
  }
  const active = campaigns[0];
  if (active.approvalRequired && active.approvalActionHref) {
    return {
      title: 'Complete the current approval checkpoint',
      summary: 'All visible review items are clear. Finalize the current campaign checkpoint to continue the launch flow.',
      href: active.approvalActionHref,
      label: 'Open checkpoint',
    };
  }
  return {
    title: 'Open your latest campaign',
    summary: 'Your workspace is ready. Check schedule, results, or prepare the next change from the active campaign.',
    href: `/campaigns/${active.id}`,
    label: 'Open campaign',
  };
}

export default function AriesHomeDashboard() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const reviews = useRuntimeReviews({ autoLoad: true });
  const profile = useBusinessProfile({ autoLoad: true });
  const integrations = useIntegrations({ autoLoad: true });

  const campaignList = campaigns.data?.campaigns ?? [];
  const reviewList = reviews.data?.reviews ?? [];
  const activeCampaign = campaignList[0] ?? null;
  const businessName = profile.profile.data?.profile.businessName || 'Your business';
  const nextAction = nextActionFor(campaignList, reviewList.length);
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const channelStates = integrationCards.map((card) => ({
    id: card.platform,
    name: card.display_name,
    handle: card.connected_account?.account_label || card.platform,
    health:
      card.connection_state === 'connected'
        ? 'connected'
        : card.connection_state === 'reauth_required'
          ? 'attention'
          : 'not_connected',
    detail:
      card.connection_state === 'connected'
        ? 'Connected and ready for scheduling.'
        : card.connection_state === 'reauth_required'
          ? 'Needs reconnection before the next launch.'
          : 'Not connected yet.',
  }));

  const loading = campaigns.isLoading || reviews.isLoading || profile.profile.isLoading;
  const loadError = campaigns.error || reviews.error || profile.profile.error;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-[2.5rem] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] px-6 py-6 shadow-[0_32px_120px_rgba(0,0,0,0.28)] md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-3">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">Home</p>
              <h2 className="text-4xl font-semibold tracking-[-0.03em] text-white">{businessName}</h2>
              <p className="max-w-2xl text-base leading-7 text-white/65">
                Aries shows what is running, what needs approval, what is scheduled next, what is working, and what to do now.
              </p>
            </div>
            <TrustRibbon />
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <MetricCard label="Campaigns" value={String(campaignList.length)} detail={activeCampaign ? 'Latest campaign is ready below.' : 'Create your first campaign to begin.'} />
            <MetricCard label="Pending approvals" value={String(reviewList.length)} detail={reviewList.length > 0 ? 'Review queue is waiting on you.' : 'Nothing needs your decision right now.'} />
            <MetricCard label="Connected channels" value={String(channelStates.filter((item) => item.health === 'connected').length)} detail={channelStates.length > 0 ? `${channelStates.length} total channels configured.` : 'No channels connected yet.'} />
          </div>
        </div>

        <ShellPanel eyebrow="Next Action" title={nextAction.title}>
          <div className="space-y-5">
            <p className="max-w-xl text-sm leading-7 text-white/70">{nextAction.summary}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={nextAction.href} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]">
                {nextAction.label}
                <ChevronRight className="h-4 w-4" />
              </Link>
              <span className="inline-flex items-center gap-2 text-sm text-white/55">
                <Sparkles className="h-4 w-4 text-white/50" />
                Nothing goes live without approval.
              </span>
            </div>
          </div>
        </ShellPanel>
      </section>

      {loading ? <LoadingStateGrid /> : null}
      {loadError ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          {loadError.message}
        </div>
      ) : null}

      {!loading && !loadError && campaignList.length === 0 ? (
        <EmptyStatePanel
          title="No campaigns yet"
          description="Set up your business and create your first campaign. Aries will keep the work calm, reviewable, and approval-safe from the start."
          action={<Link href="/onboarding/start" className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c]">Create first campaign</Link>}
        />
      ) : null}

      {!loading && !loadError && activeCampaign ? (
        <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <ShellPanel eyebrow="Active Campaign" title={activeCampaign.name} action={<StatusChip status={activeCampaign.status} />}>
            <div className="space-y-4">
              <p className="text-sm leading-7 text-white/70">{activeCampaign.summary}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <InfoTile label="Objective" value={activeCampaign.objective} />
                <InfoTile label="Current stage" value={activeCampaign.stageLabel} />
                <InfoTile label="Next scheduled" value={activeCampaign.nextScheduled} />
              </div>
              <Link href={`/campaigns/${activeCampaign.id}`} className="inline-flex items-center gap-2 text-sm font-medium text-white">
                Open campaign
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </ShellPanel>

          <div className="space-y-4">
            <ShellPanel eyebrow="Review Queue" title="What needs your decision" action={<ReviewBadge count={reviewList.length} href="/review" />}>
              {reviewList.length === 0 ? (
                <EmptyStatePanel compact title="You are clear for now" description="New review items will appear here when something needs your decision." />
              ) : (
                <div className="space-y-3">
                  {reviewList.slice(0, 3).map((item) => (
                    <Link key={item.id} href={`/review/${item.id}`} className="flex items-start justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/15 px-4 py-4 transition hover:border-white/15 hover:bg-white/[0.06]">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">{item.title}</p>
                        <p className="text-sm text-white/55">{item.channel} · {item.placement} · {item.scheduledFor}</p>
                      </div>
                      <StatusChip status={item.status} />
                    </Link>
                  ))}
                </div>
              )}
            </ShellPanel>

            <ShellPanel eyebrow="Scheduled Next" title="What is scheduled next">
              {activeCampaign.nextScheduled === 'Nothing scheduled yet' || activeCampaign.nextScheduled === 'Waiting on approval before scheduling' ? (
                <EmptyStatePanel compact title="Nothing scheduled yet" description="Approved work will appear here once the campaign is ready to schedule." />
              ) : (
                <div className="rounded-[1.25rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/70">
                  {activeCampaign.nextScheduled}
                </div>
              )}
            </ShellPanel>
          </div>
        </section>
      ) : null}

      {!loading && !loadError ? (
        <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <ShellPanel eyebrow="Results" title="What is working">
            {campaignList.some((campaign) => campaign.status === 'live') ? (
              <div className="space-y-3">
                {campaignList.filter((campaign) => campaign.status === 'live').map((campaign) => (
                  <Link key={campaign.id} href={`/results?campaign=${campaign.id}`} className="block rounded-[1.25rem] border border-white/8 bg-black/15 px-4 py-4 transition hover:border-white/15">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">{campaign.name}</p>
                        <p className="mt-1 text-sm text-white/55">Live results are available for this campaign.</p>
                      </div>
                      <StatusChip status={campaign.status} />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyStatePanel compact title="Results will appear after campaigns run" description="Once campaigns are live and real performance data exists, Aries will summarize what worked here." />
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Channel Health" title="Connected surfaces">
            {integrations.isLoading ? (
              <LoadingStateGrid />
            ) : integrations.error ? (
              <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{integrations.error.message}</div>
            ) : channelStates.length === 0 ? (
              <EmptyStatePanel compact title="No integrations yet" description="Connect channels in Settings so Aries can schedule and monitor launches." />
            ) : (
              <div className="space-y-3">
                {channelStates.slice(0, 3).map((channel) => (
                  <div key={channel.id} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">{channel.name}</p>
                        <p className="text-sm text-white/45">{channel.handle}</p>
                      </div>
                      <StatusChip status={channel.health === 'connected' ? 'approved' : channel.health === 'attention' ? 'changes_requested' : 'draft'}>
                        {channel.health === 'connected' ? 'Healthy' : channel.health === 'attention' ? 'Needs attention' : 'Not connected'}
                      </StatusChip>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-white/55">{channel.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </ShellPanel>
        </section>
      ) : null}
    </div>
  );
}

function MetricCard(props: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.035] px-5 py-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-3 text-3xl font-semibold text-white">{props.value}</p>
      <p className="mt-2 text-sm text-white/55">{props.detail}</p>
    </div>
  );
}

function InfoTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.035] px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm font-medium text-white/80">{props.value}</p>
    </div>
  );
}
