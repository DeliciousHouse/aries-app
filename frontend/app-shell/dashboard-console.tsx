'use client';

import Link from 'next/link';
import { Activity, ArrowRight, Cable, CalendarDays, ImageIcon, Sparkles, Workflow } from 'lucide-react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useLatestMarketingJob } from '@/hooks/use-latest-marketing-job';
import { useTenantWorkflows } from '@/hooks/use-tenant-workflows';
import StatusBadge from '@/frontend/components/status-badge';

function statusBadgeForConnectionState(connectionState: string): 'completed' | 'required' | 'accepted' {
  if (connectionState === 'connected') {
    return 'completed';
  }
  if (connectionState === 'reauth_required') {
    return 'required';
  }
  return 'accepted';
}

function MetricCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div className="glass rounded-[2rem] p-6">
      <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">{label}</p>
      <div className="text-4xl font-bold mb-2">{value}</div>
      <p className="text-white/55 text-sm leading-relaxed">{meta}</p>
    </div>
  );
}

export default function DashboardConsole(): JSX.Element {
  const integrations = useIntegrations();
  const tenantWorkflows = useTenantWorkflows();
  const latestJob = useLatestMarketingJob({ autoLoad: true });

  const cards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const summary =
    integrations.data?.status === 'ok'
      ? integrations.data.summary
      : { total: 0, connected: 0, not_connected: 0, attention_required: 0 };
  const workflows = tenantWorkflows.list.data ?? [];
  const campaign = latestJob.data;
  const gallery = campaign?.reviewBundle?.platformPreviews ?? [];
  const strategyLinks =
    campaign?.artifacts
      ?.filter((artifact) => artifact.stage === 'strategy' && artifact.actionHref && artifact.actionLabel)
      .slice(0, 3) ?? [];
  const approvalRequired = campaign?.approvalRequired ? 'Yes' : 'No';

  return (
    <div className="space-y-8">
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        <MetricCard
          label="Planned posts"
          value={String(campaign?.plannedPostCount ?? 0)}
          meta="Calendar-backed posts planned for the current tenant campaign."
        />
        <MetricCard
          label="Created assets"
          value={String(campaign?.createdPostCount ?? 0)}
          meta="Generated or prepared posts/assets currently available for review."
        />
        <MetricCard
          label="Campaign days"
          value={String(campaign?.durationDays ?? 0)}
          meta="Inclusive duration of the current campaign window."
        />
        <MetricCard
          label="Approval required"
          value={approvalRequired}
          meta="Whether the latest campaign is waiting on an operator checkpoint."
        />
      </div>

      <div className="grid xl:grid-cols-[1.3fr_0.9fr] gap-6">
        <div className="glass rounded-[2.5rem] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Workflow className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Tenant campaign</p>
              <h2 className="text-2xl font-bold">Latest brand campaign</h2>
            </div>
          </div>

          {latestJob.isLoading ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              Loading the latest tenant campaign…
            </div>
          ) : latestJob.error ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              {latestJob.error.message}
            </div>
          ) : !campaign ? (
            <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-8 space-y-5">
              <h3 className="text-xl font-semibold">No campaign has been launched yet</h3>
              <p className="text-white/60 leading-relaxed">
                Launch the canonical brand campaign to populate the dashboard with real creatives, dates, and post counts.
              </p>
              <Link href="/marketing/new-job" className="inline-flex items-center gap-2 px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
                Launch campaign <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-6">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">Brand</p>
                    <h3 className="text-3xl font-bold mb-2">{campaign.tenantName || 'Current tenant'}</h3>
                    <p className="text-white/60 break-all">{campaign.brandWebsiteUrl || 'Brand website unavailable'}</p>
                  </div>
                  <StatusBadge status={campaign.marketing_job_status as any} />
                </div>
                {campaign.campaignWindow ? (
                  <div className="grid md:grid-cols-2 gap-4 mt-6">
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">Campaign window</p>
                      <p className="text-white/80">{campaign.campaignWindow.start || 'n/a'} to {campaign.campaignWindow.end || 'n/a'}</p>
                    </div>
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">Next action</p>
                      <p className="text-white/80">{campaign.nextStep.replace(/_/g, ' ')}</p>
                    </div>
                  </div>
                ) : null}
                <div className="mt-6">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">Strategy plan links</p>
                  {strategyLinks.length === 0 ? (
                    <p className="text-sm text-white/55">
                      No strategy artifact links are published yet. They appear here once strategy outputs are available.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {strategyLinks.map((artifact) => (
                        <Link
                          key={artifact.id}
                          href={artifact.actionHref!}
                          className="text-sm text-primary hover:text-primary/80 transition-colors"
                        >
                          {artifact.actionLabel}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <ImageIcon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/35">Creative gallery</p>
                    <h3 className="text-xl font-semibold">Generated previews</h3>
                  </div>
                </div>
                {gallery.length === 0 ? (
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
                    No generated preview media is available yet for this campaign.
                  </div>
                ) : (
                  <div className="grid md:grid-cols-2 gap-4">
                    {gallery.slice(0, 4).map((preview) => (
                      <Link
                        key={preview.id}
                        href={`/marketing/job-approve?jobId=${encodeURIComponent(campaign.jobId)}&preview=${encodeURIComponent(preview.id)}`}
                        className="rounded-[1.5rem] overflow-hidden border border-white/10 bg-white/5 hover:bg-white/10 transition-colors"
                      >
                        {preview.mediaAssets[0]?.contentType.startsWith('image/') ? (
                          <img src={preview.mediaAssets[0].url} alt={preview.platformName} className="w-full h-48 object-cover" />
                        ) : (
                          <div className="h-48 flex items-center justify-center text-white/45 bg-black/20">Preview asset</div>
                        )}
                        <div className="p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{preview.platformName}</p>
                          <h4 className="font-semibold mb-1">{preview.displayTitle || preview.summary}</h4>
                          <p className="text-sm text-white/55">{preview.summary}</p>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="glass rounded-[2.5rem] p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
                <Cable className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Connection summary</p>
                <h2 className="text-2xl font-bold">Platform health</h2>
                <p className="text-sm text-white/55 mt-2">
                  {summary.connected} connected of {summary.total} configured platforms.
                </p>
              </div>
            </div>

            {integrations.isLoading ? (
              <div className="text-white/60">Loading platform status…</div>
            ) : integrations.error ? (
              <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
                {integrations.error.message}
              </div>
            ) : (
              <div className="space-y-3">
                {cards.map((card) => (
                  <div key={card.platform} className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-semibold">{card.display_name}</div>
                      <div className="text-sm text-white/50">{card.connection_state.replace(/_/g, ' ')}</div>
                    </div>
                    <StatusBadge status={statusBadgeForConnectionState(card.connection_state)} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass rounded-[2.5rem] p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center">
                <CalendarDays className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Campaign surfaces</p>
                <h2 className="text-2xl font-bold">Open the workspace</h2>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Link href="/onboarding/pipeline-intake" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Start brand + competitor research <ArrowRight className="w-4 h-4" />
              </Link>
              <Link href={campaign ? `/marketing/job-status?jobId=${encodeURIComponent(campaign.jobId)}` : '/marketing/new-job'} className="px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 flex items-center justify-center gap-2">
                {campaign ? 'Open campaign status' : 'Launch campaign'} <ArrowRight className="w-4 h-4" />
              </Link>
              {campaign?.approval?.actionHref ? (
                <Link href={campaign.approval.actionHref} className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                  Open approval checkpoint <Activity className="w-4 h-4" />
                </Link>
              ) : null}
              <Link href="/dashboard/posts" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Review post queue <Activity className="w-4 h-4" />
              </Link>
              <Link href="/dashboard/calendar" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Open calendar <Sparkles className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
