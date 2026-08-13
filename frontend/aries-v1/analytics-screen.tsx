'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { InsightsAccountMetricPoint, InsightsPostItem } from '@/lib/api/aries-v1';
import { useInsightsAnalytics } from '@/hooks/use-insights-analytics';
import type { Platform } from '@/backend/insights/platforms/registry';
import { PLATFORM_LABELS } from '@/backend/insights/platforms/registry';
import { platformSupports } from '@/backend/insights/platforms/capabilities';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, MetricCard, ShellPanel } from './components';
import { PlatformSelector } from './platform-selector';

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

function formatDay(value: string): string {
  // Account-metric `date` is already a YYYY-MM-DD string; posts `publishedAt`
  // is an ISO timestamp. Keep just the day to avoid locale/hydration drift.
  if (typeof value !== 'string') return '—';
  return value.slice(0, 10) || '—';
}

// Per-platform reasons why account-level metrics are unavailable.
// Must be honest and specific — never a fabricated zero or generic stub.
const ACCOUNT_METRICS_UNAVAILABLE_REASON: Partial<Record<Platform, string>> = {
  x: 'Impressions require a paid X API tier.',
  reddit: "Reddit doesn't expose reach/impression metrics.",
  linkedin: 'Account-level analytics need LinkedIn organization access.',
};

// AA-229 PR1: resolve the platform the /insights drill-down link
// (frontend/insights/AnalyticsDrilldownLink.tsx) carried over. Query params
// are untrusted input — only honor a platform this screen can actually
// render (enabledPlatforms is server-resolved from rollout flags and never
// includes Instagram), falling back to the same default as a bare visit.
function resolveInitialPlatform(paramValue: string | null, enabledPlatforms: Platform[]): Platform {
  if (paramValue && (enabledPlatforms as string[]).includes(paramValue)) {
    return paramValue as Platform;
  }
  return enabledPlatforms[0] ?? 'facebook';
}

// The read-api summary/account-metrics handlers clamp `days` to 1..90
// server-side; mirror that here so an invalid query param never silently
// diverges from what the request will actually be answered with.
//
// AA-229 F5: mirrors lib/db-pool-config.ts's parsePoolMax convention — only
// an explicit unsigned-integer string is honored. A bare Number.parseInt
// would also accept 'NaN'-adjacent junk it shouldn't (parseInt('1e3', 10)
// is 1, parseInt('30abc', 10) is 30 — both silently truncate instead of
// rejecting), so validate the whole string with a strict digits-only regex
// first. (An earlier draft of this comment claimed parseInt never returns
// Infinity — it does: Number.parseInt('9'.repeat(400), 10) is Infinity. The
// digits-only gate runs first and Math.min(Infinity, 90) clamps to 90, so the
// check below is correct either way; Number.isNaN is used because after the
// regex the only way parse can fail is NaN.)
function resolveDaysParam(paramValue: string | null): number | undefined {
  if (!paramValue || !/^\d+$/.test(paramValue)) return undefined;
  const parsed = Number.parseInt(paramValue, 10);
  if (Number.isNaN(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), 90);
}

export default function AriesAnalyticsScreen({
  enabledPlatforms = ['facebook'],
}: {
  enabledPlatforms?: Platform[];
}) {
  const searchParams = useSearchParams();
  // AA-229 F4: both platform and days are captured ONCE at mount, from the
  // same searchParams read — the URL is a one-time hand-off from the
  // /insights drill-down link, not a live binding. `platform` has to be a
  // lazy useState initializer because it's also user-adjustable in-page via
  // PlatformSelector; `days` is seeded the same way (rather than recomputed
  // every render) purely so the two halves of "the window" can never drift
  // apart from each other if this screen ever gains an in-page navigation
  // that updates the URL without a full remount.
  const [platform, setPlatform] = useState<Platform>(() =>
    resolveInitialPlatform(searchParams.get('platform'), enabledPlatforms),
  );
  const [days] = useState<number | undefined>(() => resolveDaysParam(searchParams.get('days')));

  const analytics = useInsightsAnalytics({ autoLoad: true, platform, days });
  const data = analytics.data;

  const summary = data?.summary;
  const series: InsightsAccountMetricPoint[] = data?.accountMetrics.series ?? [];
  const posts: InsightsPostItem[] = data?.posts.posts ?? [];

  // hasData is only consulted in the accountMetricsSupported path (facebook/instagram).
  // For unsupported-account-metrics platforms the sections are independently gated.
  const hasData = Boolean(
    summary &&
      (summary.totalReach > 0 ||
        summary.currentFollowers > 0 ||
        summary.followersGained > 0 ||
        summary.totalEngagement > 0 ||
        summary.totalLikes > 0 ||
        summary.totalComments > 0 ||
        summary.totalShares > 0 ||
        series.length > 0 ||
        posts.length > 0),
  );

  const accountMetricsSupported = platformSupports(platform, 'account_daily_metrics');
  const postViewsSupported = platformSupports(platform, 'post_view_count');
  const commentsSupported = platformSupports(platform, 'comments');
  const postSharesSupported = platformSupports(platform, 'post_share_count');

  const label = PLATFORM_LABELS[platform];

  // Shared posts table — rendered in both the supported and unsupported account-metrics
  // paths. Views column is omitted for platforms that don't surface per-post view counts
  // (x, reddit, linkedin). For youtube/instagram/facebook postViewsSupported=true so the
  // column renders as it does today.
  // AA-229 F7: this table is NOT windowed by `days` — useInsightsAnalytics calls
  // getInsightsPosts({ platform }) only (no days param; the endpoint has none —
  // backend/insights/read-api.ts's handleGetInsightsPosts takes platform/limit/offset,
  // period-free by design). It always shows the latest `limit` (20) posts of all time,
  // regardless of the period the /insights drill-down carried in. Pre-existing (the
  // hook never sent `days` to any endpoint before AA-229), but now sits directly under
  // metric cards labelled "Last N days" — worth calling out rather than implying the
  // table is windowed too.
  // AA-230: the underlying value is now reach-preferred (COALESCE(reach, views, 0)) to
  // agree with the other ten readers, but the LABEL stays "Views" on purpose. Instagram
  // is the only adapter that populates `reach`, and this screen cannot select Instagram
  // (app/dashboard/analytics/page.tsx builds enabledPlatforms without it), so for every
  // platform renderable here the COALESCE resolves to `views` and "Reach" would be a
  // false label. Make the label reach-aware — per getReachLabel in
  // backend/insights/narrative/snapshot-builder.ts — when Instagram becomes selectable;
  // that, and the postViewsSupported capability gate, are AA-229 (migration item 8).
  const postsTable = (
    <ShellPanel eyebrow="Posts" title="Per-post performance">
      {posts.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                <th className="py-3 pr-4 font-semibold">Post</th>
                <th className="py-3 pr-4 font-semibold">Published</th>
                {postViewsSupported && <th className="py-3 pr-4 text-right font-semibold">Views</th>}
                <th className="py-3 pr-4 text-right font-semibold">Likes</th>
                {commentsSupported && <th className="py-3 pr-4 text-right font-semibold">Comments</th>}
                {postSharesSupported && <th className="py-3 text-right font-semibold">Shares</th>}
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id} className="border-b border-white/[0.06] text-white/75">
                  <td className="max-w-[18rem] truncate py-3 pr-4 text-white/90">
                    {post.title?.trim() || post.externalPostId}
                  </td>
                  <td className="py-3 pr-4 text-white/55">{formatDay(post.publishedAt)}</td>
                  {postViewsSupported && (
                    <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalReach)}</td>
                  )}
                  <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalLikes)}</td>
                  {commentsSupported && <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalComments)}</td>}
                  {postSharesSupported && <td className="py-3 text-right">{formatNumber(post.metrics.totalShares)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-white/55">No post-level metrics yet.</p>
      )}
    </ShellPanel>
  );

  return (
    <div className="space-y-5">
      <ShellPanel
        eyebrow="Analytics"
        title={`${label} performance`}
        action={
          enabledPlatforms.length > 1 ? (
            <PlatformSelector
              platforms={enabledPlatforms}
              value={platform}
              onChange={setPlatform}
            />
          ) : null
        }
      >
        {platform === 'facebook' ? (
          <p className="max-w-3xl text-sm leading-7 text-white/65">
            Views, followers, and engagement from your connected Facebook Page, plus per-post results.
            Numbers populate here after Aries syncs analytics from Meta.
          </p>
        ) : (
          <p className="max-w-3xl text-sm leading-7 text-white/65">
            Views, followers, and engagement from your connected {label} account, plus per-post results.
            Numbers populate here after Aries syncs analytics.
          </p>
        )}
      </ShellPanel>

      {analytics.isLoading ? (
        <LoadingStateGrid />
      ) : analytics.error ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          <p>{customerSafeUiErrorMessage(analytics.error.message, 'Analytics are not available right now.')}</p>
          <button
            type="button"
            onClick={() => void analytics.load()}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-50 transition hover:bg-red-500/20"
          >
            Try again
          </button>
        </div>
      ) : !accountMetricsSupported ? (
        // Platform doesn't expose account-level metrics (x, reddit, linkedin, youtube).
        // Show an honest panel instead of fabricated zeros, then render post-level data
        // if any exists. The per-post Views column is also gated by postViewsSupported.
        <>
          <EmptyStatePanel
            title={`Account analytics aren't available for ${label}`}
            description={
              ACCOUNT_METRICS_UNAVAILABLE_REASON[platform] ??
              'Account-level metrics are not available for this platform.'
            }
          />
          {postsTable}
        </>
      ) : !hasData || !summary ? (
        <EmptyStatePanel
          title="No analytics yet"
          description={
            platform === 'facebook'
              ? 'Once your Facebook posts are live and Aries has synced performance data from Meta, your views, followers, and per-post results will appear here.'
              : `Once your ${label} posts are live and Aries has synced performance data, your views, followers, and per-post results will appear here.`
          }
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <MetricCard label="Views" value={formatNumber(summary.totalReach)} detail={`Last ${summary.period.days} days`} />
            <MetricCard
              label="Followers"
              value={formatNumber(summary.currentFollowers)}
              detail={`${summary.followersGained >= 0 ? '+' : ''}${formatNumber(summary.followersGained)} in period`}
              tone={summary.followersGained > 0 ? 'good' : 'default'}
            />
            <MetricCard label="Engagement" value={formatNumber(summary.totalEngagement)} detail="Likes + comments + shares" />
            <MetricCard label="Likes" value={formatNumber(summary.totalLikes)} detail={`Last ${summary.period.days} days`} />
            <MetricCard label="Comments" value={formatNumber(summary.totalComments)} detail={`Last ${summary.period.days} days`} />
            <MetricCard label="Shares" value={formatNumber(summary.totalShares)} detail={`Last ${summary.period.days} days`} />
          </div>

          <ShellPanel eyebrow="Trend" title="Followers and views over time">
            {series.length > 0 ? (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 12, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }} tickFormatter={formatDay} />
                    <YAxis tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }} width={48} />
                    <Tooltip
                      contentStyle={{
                        background: '#0f151b',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 12,
                        color: '#fff',
                      }}
                      labelFormatter={(label) => formatDay(String(label))}
                    />
                    <Line type="monotone" dataKey="followers" name="Followers" stroke="#a78bfa" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="reach" name="Views" stroke="#34d399" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-white/55">No daily trend data for this window yet.</p>
            )}
          </ShellPanel>

          {postsTable}
        </>
      )}
    </div>
  );
}
