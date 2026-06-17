'use client';

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

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, MetricCard, ShellPanel } from './components';

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

export default function AriesAnalyticsScreen() {
  const analytics = useInsightsAnalytics({ autoLoad: true, platform: 'facebook' });
  const data = analytics.data;

  const summary = data?.summary;
  const series: InsightsAccountMetricPoint[] = data?.accountMetrics.series ?? [];
  const posts: InsightsPostItem[] = data?.posts.posts ?? [];

  const hasData = Boolean(
    summary &&
      (summary.totalViews > 0 ||
        summary.currentFollowers > 0 ||
        summary.followersGained > 0 ||
        summary.totalEngagement > 0 ||
        summary.totalLikes > 0 ||
        summary.totalComments > 0 ||
        summary.totalShares > 0 ||
        series.length > 0 ||
        posts.length > 0),
  );

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Analytics" title="Facebook performance">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Views, followers, and engagement from your connected Facebook Page, plus per-post results.
          Numbers populate here after Aries syncs analytics from Meta.
        </p>
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
      ) : !hasData || !summary ? (
        <EmptyStatePanel
          title="No analytics yet"
          description="Once your Facebook posts are live and Aries has synced performance data from Meta, your views, followers, and per-post results will appear here."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <MetricCard label="Views" value={formatNumber(summary.totalViews)} detail={`Last ${summary.period.days} days`} />
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
                    <Line type="monotone" dataKey="views" name="Views" stroke="#34d399" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-white/55">No daily trend data for this window yet.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Posts" title="Per-post performance">
            {posts.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">Post</th>
                      <th className="py-3 pr-4 font-semibold">Published</th>
                      <th className="py-3 pr-4 text-right font-semibold">Views</th>
                      <th className="py-3 pr-4 text-right font-semibold">Likes</th>
                      <th className="py-3 pr-4 text-right font-semibold">Comments</th>
                      <th className="py-3 text-right font-semibold">Shares</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((post) => (
                      <tr key={post.id} className="border-b border-white/[0.06] text-white/75">
                        <td className="max-w-[18rem] truncate py-3 pr-4 text-white/90">
                          {post.title?.trim() || post.externalPostId}
                        </td>
                        <td className="py-3 pr-4 text-white/55">{formatDay(post.publishedAt)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalViews)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalLikes)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(post.metrics.totalComments)}</td>
                        <td className="py-3 text-right">{formatNumber(post.metrics.totalShares)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-white/55">No post-level metrics yet.</p>
            )}
          </ShellPanel>
        </>
      )}
    </div>
  );
}
