'use client';

import type { JSX } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, Cable, CalendarDays, ImageIcon, Sparkles, Workflow } from 'lucide-react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useLatestMarketingJob } from '@/hooks/use-latest-marketing-job';
import { useTenantWorkflows } from '@/hooks/use-tenant-workflows';
import { useTenantTimezone } from '@/hooks/use-tenant-timezone';
import { formatInTenantZone, tenantZoneAbbreviation } from '@/lib/format-timestamp';
import StatusBadge from '@/frontend/components/status-badge';
import type { SocialContentCalendarEvent } from '@/lib/api/marketing';

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
      <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-3">{label}</p>
      <div className="text-4xl font-bold mb-2">{value}</div>
      <p className="text-white/55 text-sm leading-relaxed">{meta}</p>
    </div>
  );
}

function contentCalendarLabel(isWeeklyMode: boolean, durationDays?: number | null): string {
  if (!isWeeklyMode) {
    return 'Post window';
  }
  return typeof durationDays === 'number' && Number.isFinite(durationDays) && durationDays > 0
    ? `${durationDays}-day content calendar`
    : 'weekly content calendar';
}

export function dashboardWeeklyCreativeReadyCount(events: SocialContentCalendarEvent[]): number {
  return events.filter(
    (event) =>
      (event.postType === 'static' || event.postType === 'image') &&
      !!event.assetPreviewId,
  ).length;
}

export function dashboardConsoleCopyForMode(isWeeklyMode: boolean, durationDays?: number | null): Record<string, string> {
  const calendarLabel = contentCalendarLabel(isWeeklyMode, durationDays);
  return {
    plannedPostsLabel: isWeeklyMode ? 'Posts planned' : 'Planned posts',
    plannedPostsMeta: isWeeklyMode
      ? 'Weekly content plan items scheduled in the current window.'
      : 'Calendar-backed posts planned for the current social content job.',
    createdAssetsLabel: isWeeklyMode ? 'Creatives ready' : 'Created assets',
    createdAssetsMeta: isWeeklyMode
      ? 'Image creatives attached to weekly posts and ready for review.'
      : 'Generated or prepared posts/assets currently available for review.',
    durationLabel: isWeeklyMode ? 'Video script ready' : 'Post window days',
    durationMeta: isWeeklyMode
      ? 'Video scripts completed and available in the weekly plan.'
      : 'Inclusive duration of the current post window.',
    approvalLabel: isWeeklyMode ? calendarLabel : 'Approval required',
    approvalMeta: isWeeklyMode
      ? 'Current weekly calendar length in days.'
      : 'Whether the latest social content job is waiting on an operator checkpoint.',
    tenantTitle: isWeeklyMode ? 'Weekly content plan' : 'Latest social content job',
    emptyDescription: isWeeklyMode
      ? 'Start a weekly content plan to populate the dashboard with real creatives, dates, and post counts.'
      : 'Launch a social content job to populate the dashboard with real creatives, dates, and post counts.',
    emptyActionLabel: isWeeklyMode ? 'Start weekly content plan' : 'Launch social content job',
    windowLabel: calendarLabel,
    statusActionLabel: isWeeklyMode ? 'Open weekly content plan' : 'Open social content job status',
    newActionLabel: isWeeklyMode ? 'Start weekly content plan' : 'Launch social content job',
  };
}

export default function DashboardConsole(): JSX.Element {
  const integrations = useIntegrations();
  const tenantWorkflows = useTenantWorkflows();
  const latestJob = useLatestMarketingJob({ autoLoad: true });
  const tz = useTenantTimezone();

  const cards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const summary =
    integrations.data?.status === 'ok'
      ? integrations.data.summary
      : { total: 0, connected: 0, not_connected: 0, attention_required: 0 };
  const workflows = tenantWorkflows.list.data ?? [];
  const socialContentJob = latestJob.data;
  const gallery = socialContentJob?.reviewBundle?.platformPreviews ?? [];
  const weeklyEvents = (socialContentJob?.calendarEvents ?? []).filter(
    (event): event is SocialContentCalendarEvent =>
      typeof event === 'object' && event !== null && 'dayIndex' in event && 'postType' in event,
  );
  const isWeeklyMode = weeklyEvents.length > 0;
  const weeklyCreativeReadyCount = dashboardWeeklyCreativeReadyCount(weeklyEvents);
  const weeklyVideoScriptReadyCount = weeklyEvents.filter(
    (event) => event.postType === 'video_script' && event.status !== 'draft',
  ).length;
  const copy = dashboardConsoleCopyForMode(isWeeklyMode, socialContentJob?.durationDays ?? null);
  const strategyLinks =
    socialContentJob?.artifacts
      ?.filter((artifact) => artifact.stage === 'strategy' && artifact.actionHref && artifact.actionLabel)
      .slice(0, 3) ?? [];
  const approvalRequired = socialContentJob?.approvalRequired ? 'Yes' : 'No';

  return (
    <div className="space-y-8">
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        <MetricCard
          label={copy.plannedPostsLabel}
          value={String(socialContentJob?.plannedPostCount ?? 0)}
          meta={copy.plannedPostsMeta}
        />
        <MetricCard
          label={copy.createdAssetsLabel}
          value={String(isWeeklyMode ? weeklyCreativeReadyCount : socialContentJob?.createdPostCount ?? 0)}
          meta={copy.createdAssetsMeta}
        />
        <MetricCard
          label={copy.durationLabel}
          value={String(isWeeklyMode ? weeklyVideoScriptReadyCount : socialContentJob?.durationDays ?? 0)}
          meta={copy.durationMeta}
        />
        <MetricCard
          label={copy.approvalLabel}
          value={isWeeklyMode ? String(socialContentJob?.durationDays ?? 0) : approvalRequired}
          meta={copy.approvalMeta}
        />
      </div>

      <div className="grid xl:grid-cols-[1.3fr_0.9fr] gap-6">
        <div className="glass rounded-[2.5rem] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Workflow className="w-6 h-6 text-violet-300" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/70">Social content job</p>
              <h2 className="text-2xl font-bold">{copy.tenantTitle}</h2>
            </div>
          </div>

          {latestJob.isLoading ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              Loading the latest social content job…
            </div>
          ) : latestJob.error ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              {latestJob.error.message}
            </div>
          ) : !socialContentJob ? (
            <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-8 space-y-5">
              <h3 className="text-xl font-semibold">No social content job has been launched yet</h3>
              <p className="text-white/60 leading-relaxed">
                {copy.emptyDescription}
              </p>
              <Link href="/marketing/new-job" className="inline-flex items-center gap-2 px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
                {copy.emptyActionLabel} <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-6">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-2">Brand</p>
                    <h3 className="text-3xl font-bold mb-2">{socialContentJob.tenantName || 'Current tenant'}</h3>
                    <p className="text-white/60 break-all">{socialContentJob.brandWebsiteUrl || 'Brand website unavailable'}</p>
                  </div>
                  <StatusBadge status={socialContentJob.marketing_job_status as any} />
                </div>
                {socialContentJob.postWindow ? (
                  <div className="grid md:grid-cols-2 gap-4 mt-6">
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-2">
                        {copy.windowLabel}
                      </p>
                      <p className="text-white/80">
                        {socialContentJob.postWindow.start ? `${formatInTenantZone(socialContentJob.postWindow.start, tz)} ${tenantZoneAbbreviation(socialContentJob.postWindow.start, tz)}` : 'n/a'} to {socialContentJob.postWindow.end ? `${formatInTenantZone(socialContentJob.postWindow.end, tz)} ${tenantZoneAbbreviation(socialContentJob.postWindow.end, tz)}` : 'n/a'}
                      </p>
                    </div>
                    <div className="rounded-[1.25rem] border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-2">Next action</p>
                      <p className="text-white/80">{socialContentJob.nextStep.replace(/_/g, ' ')}</p>
                    </div>
                  </div>
                ) : null}
                <div className="mt-6">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-2">Strategy plan links</p>
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
                          className="text-sm text-violet-300 hover:text-violet-300 transition-colors"
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
                    <ImageIcon className="w-5 h-5 text-violet-300" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/70">Creative gallery</p>
                    <h3 className="text-xl font-semibold">Generated previews</h3>
                  </div>
                </div>
                {gallery.length === 0 ? (
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
                    No generated preview media is available yet for this social content job.
                  </div>
                ) : (
                  <div className="grid md:grid-cols-2 gap-4">
                    {gallery.slice(0, 4).map((preview) => (
                      <Link
                        key={preview.id}
                        href={`/marketing/job-approve?jobId=${encodeURIComponent(socialContentJob.jobId)}&preview=${encodeURIComponent(preview.id)}`}
                        className="rounded-[1.5rem] overflow-hidden border border-white/10 bg-white/5 hover:bg-white/10 transition-colors"
                      >
                        {preview.mediaAssets[0]?.contentType.startsWith('image/') ? (
                          <img src={preview.mediaAssets[0].url} alt={preview.platformName} className="w-full h-48 object-cover" />
                        ) : (
                          <div className="h-48 flex items-center justify-center text-white/70 bg-black/20">Preview asset</div>
                        )}
                        <div className="p-4">
                          <p className="text-xs uppercase tracking-[0.22em] text-white/70 mb-2">{preview.platformName}</p>
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
                <p className="text-xs uppercase tracking-[0.24em] text-white/70">Connection summary</p>
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
                      {card.available_actions.some((action) => action === 'connect' || action === 'reconnect') ? (
                        <div className="mt-2 flex gap-2">
                          <Link
                            href={`/oauth/connect/${encodeURIComponent(card.platform)}?mode=${card.available_actions.includes('reconnect') ? 'reconnect' : 'connect'}${card.connection_id ? `&connection_id=${encodeURIComponent(card.connection_id)}` : ''}`}
                            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 transition"
                          >
                            {card.available_actions.includes('reconnect') ? 'Reconnect' : 'Connect'}
                          </Link>
                        </div>
                      ) : null}
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
                <p className="text-xs uppercase tracking-[0.24em] text-white/70">Social content surfaces</p>
                <h2 className="text-2xl font-bold">Open the workspace</h2>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Link href="/onboarding/start" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Start brand + competitor research <ArrowRight className="w-4 h-4" />
              </Link>
              <Link href={socialContentJob ? `/marketing/job-status?jobId=${encodeURIComponent(socialContentJob.jobId)}` : '/marketing/new-job'} className="px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 flex items-center justify-center gap-2">
                {socialContentJob ? copy.statusActionLabel : copy.newActionLabel} <ArrowRight className="w-4 h-4" />
              </Link>
              {socialContentJob?.approval?.actionHref ? (
                <Link href={socialContentJob.approval.actionHref} className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                  Open approval checkpoint <Activity className="w-4 h-4" />
                </Link>
              ) : null}
              <Link href="/dashboard/posts" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Review post queue <Activity className="w-4 h-4" />
              </Link>
              <Link href="/dashboard/calendar" className="px-6 py-4 rounded-full bg-white text-black font-semibold transition-all flex items-center justify-center gap-2">
                Open calendar <Sparkles className="w-4 h-4 text-black" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
