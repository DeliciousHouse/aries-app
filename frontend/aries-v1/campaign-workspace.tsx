'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';

import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
import { useRuntimeReviews } from '@/hooks/use-runtime-reviews';

import { ActivityFeed, EmptyStatePanel, PublishReceipt, ScheduleComposer, SectionLink, ShellPanel, StatusChip } from './components';

const tabs = ['Overview', 'Plan', 'Creative', 'Schedule', 'Results'] as const;

function campaignStatus(status: string, approvalRequired: boolean) {
  if (approvalRequired) return 'in_review';
  if ((status || '').toLowerCase().includes('complete')) return 'scheduled';
  if ((status || '').toLowerCase().includes('fail')) return 'changes_requested';
  return 'draft';
}

export default function AriesCampaignWorkspace(props: { campaignId: string }) {
  const job = useMarketingJobStatus({ jobId: props.campaignId, autoLoad: true });
  const reviews = useRuntimeReviews({ autoLoad: true });
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('Overview');
  const [showActivity, setShowActivity] = useState(false);

  const status = job.data && !('error' in job.data) ? job.data : null;
  const campaignReviews = useMemo(
    () => (reviews.data?.reviews ?? []).filter((item) => item.campaignId === props.campaignId),
    [reviews.data, props.campaignId],
  );

  if (job.isLoading) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading campaign…</div>;
  }

  if (job.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{job.error.message}</div>;
  }

  if (!status) {
    return <EmptyStatePanel title="Campaign not found" description="This campaign could not be loaded from the current runtime state." />;
  }

  const uiStatus = campaignStatus(status.marketing_job_status, status.approvalRequired);
  const campaignName = status.reviewBundle?.campaignName || status.tenantName || `Campaign ${status.jobId}`;
  const nextScheduled = status.calendarEvents[0]?.startsAt || (status.approvalRequired ? 'Waiting on approval before scheduling' : 'Nothing scheduled yet');

  return (
    <div className="space-y-6">
      <ShellPanel eyebrow="Campaign" title={campaignName}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={uiStatus} />
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {status.campaignWindow?.start && status.campaignWindow?.end ? `${status.campaignWindow.start} - ${status.campaignWindow.end}` : 'Dates not scheduled yet'}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {status.summary.headline}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-7 text-white/65">{status.summary.subheadline}</p>
          <div className="flex flex-wrap gap-3">
            {status.stageCards.map((stage) => (
              <div key={stage.stage} className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm border-white/8 bg-white/[0.03] text-white/75">
                <span>{stage.label}</span>
                <span className="text-white/40">{stage.status}</span>
              </div>
            ))}
          </div>
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
              <InfoCard label="Current stage" value={status.marketing_stage || 'Unknown'} />
              <InfoCard label="Pending approvals" value={String(campaignReviews.length)} />
              <InfoCard label="Next scheduled" value={nextScheduled} />
              <InfoCard label="Planned posts" value={String(status.plannedPostCount ?? 0)} />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <SectionLink href="/review" label="Open review queue" />
              <SectionLink href="/dashboard/calendar" label="Open calendar" />
              <SectionLink href="/dashboard/results" label="See results" />
            </div>
          </ShellPanel>

          <ShellPanel eyebrow="Recommended" title={status.approval?.title || 'No recommendation yet'}>
            {status.approval ? (
              <div className="space-y-4">
                <p className="text-sm leading-7 text-white/65">{status.approval.message}</p>
                {status.approval.actionHref && status.approval.actionLabel ? (
                  <Link href={status.approval.actionHref} className="inline-flex items-center gap-2 text-sm font-medium text-white">
                    {status.approval.actionLabel}
                  </Link>
                ) : null}
              </div>
            ) : (
              <EmptyStatePanel compact title="No recommendation yet" description="Aries will surface the next best action when this campaign needs your attention." />
            )}
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Plan' ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <ShellPanel eyebrow="Plan" title="Campaign summary">
            <div className="space-y-5 text-sm leading-7 text-white/68">
              {status.stageCards.map((stage) => (
                <div key={stage.stage}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{stage.label}</p>
                  <p className="mt-2">{stage.summary}</p>
                  {stage.highlight ? <p className="mt-1 text-white/50">{stage.highlight}</p> : null}
                </div>
              ))}
            </div>
          </ShellPanel>
          <ShellPanel eyebrow="Channels" title="Where this campaign will run">
            <div className="space-y-4">
              {(status.publishConfig.platforms.length === 0 ? ['No platforms selected yet'] : status.publishConfig.platforms).map((channel) => (
                <div key={channel} className="rounded-[1.2rem] border border-white/8 bg-black/12 px-4 py-4 text-sm text-white/75">
                  {channel}
                </div>
              ))}
            </div>
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Creative' ? (
        <div className="space-y-4">
          <ShellPanel eyebrow="Creative" title="Review-ready assets">
            {status.reviewBundle ? (
              <div className="space-y-4">
                <p className="max-w-3xl text-sm leading-7 text-white/65">{status.reviewBundle.summary}</p>
                <div className="grid gap-4 xl:grid-cols-2">
                  {status.reviewBundle.platformPreviews.map((preview) => (
                    <div key={preview.id} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{preview.channelType}</p>
                        <strong>{preview.platformName}</strong>
                      </div>
                      <p className="text-white/60 m-0">{preview.summary}</p>
                      {preview.headline ? <span className="text-white/70"><strong className="text-white">Headline:</strong> {preview.headline}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyStatePanel compact title="No creative previews yet" description="Creative previews will appear here once production outputs are available." />
            )}
          </ShellPanel>
          {campaignReviews.length > 0 ? (
            <ShellPanel eyebrow="Review" title="Items waiting on approval">
              <div className="space-y-3">
                {campaignReviews.map((item) => (
                  <Link key={item.id} href={`/review/${item.id}`} className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 transition hover:border-white/16">
                    <div>
                      <p className="text-sm font-medium text-white">{item.title}</p>
                      <p className="text-sm text-white/50">{item.channel} · {item.scheduledFor}</p>
                    </div>
                    <StatusChip status={item.status} />
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
                Aries keeps every scheduled item readable and approval-safe. If something changes materially, it moves back into review before scheduling continues.
              </p>
              {status.calendarEvents.length === 0 ? (
                <EmptyStatePanel compact title="Nothing is scheduled yet" description="Approved work will appear here once this campaign is ready to place on the calendar." />
              ) : (
                <ScheduleComposer items={status.calendarEvents.map((event) => ({ id: event.id, title: event.title, channel: event.platform, scheduledFor: event.startsAt, status: uiStatus }))} />
              )}
              <PublishReceipt />
            </div>
          </ShellPanel>
        </div>
      ) : null}

      {activeTab === 'Results' ? (
        <div className="space-y-4">
          <ShellPanel eyebrow="Results" title="Business-readable performance">
            {String(status.marketing_job_status).toLowerCase().includes('complete') ? (
              <p className="max-w-3xl text-sm leading-7 text-white/65">This campaign has completed its current launch flow. A richer performance summary route still needs to be wired to the analytics source of truth.</p>
            ) : (
              <EmptyStatePanel compact title="Results will appear after this campaign runs" description="Once this campaign is live and real performance data exists, Aries will summarize what worked here." />
            )}
          </ShellPanel>
        </div>
      ) : null}

      <button type="button" onClick={() => setShowActivity((current) => !current)} className="inline-flex items-center gap-2 text-sm font-medium text-white/70 transition hover:text-white">
        {showActivity ? 'Hide activity history' : 'Show activity history'}
        <ChevronDown className={`h-4 w-4 transition ${showActivity ? 'rotate-180' : ''}`} />
      </button>

      {showActivity ? (
        <ShellPanel eyebrow="Activity" title="Recent changes and decisions">
          <ActivityFeed items={status.timeline.map((entry) => ({ id: entry.id, label: entry.label, detail: entry.description, at: entry.at || 'Unknown' }))} />
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
