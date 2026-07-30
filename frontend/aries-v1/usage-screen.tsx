'use client';

import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  fetchUsageAnalytics,
  type UsageAnalytics,
  type UsageGranularity,
} from '@/lib/api/usage-analytics';

import { EmptyStatePanel, MetricCard, ShellPanel } from './components';

/**
 * AA-166 — the customer-facing usage breakdown.
 *
 * Measured in TASKS, not tokens: Hermes does not report token usage back to
 * Aries, so every AI row's token columns are NULL. The token view stays
 * available and says so plainly rather than drawing a zero — `tokensReported`
 * is the server's answer to "did any AI work in this window report its usage".
 */

const GRANULARITY_OPTIONS: { value: UsageGranularity; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/**
 * Fixed hue order, never cycled — the engine an entity IS decides its color, so
 * a filtered-out engine never repaints the others. Validated for the dark
 * surface (lightness band, chroma, CVD separation, contrast); every row is also
 * directly labelled, so color is never the only channel.
 */
const ENGINE_COLORS: Record<string, string> = {
  AI_LLM: '#7c6cf0',
  DETERMINISTIC_RULE: '#12a374',
  LOCAL_EDGE: '#b45309',
};

const ENGINE_LABELS: Record<string, string> = {
  AI_LLM: 'AI models',
  DETERMINISTIC_RULE: 'Automated rules',
  LOCAL_EDGE: 'Local compute',
};

const ENGINE_DETAIL: Record<string, string> = {
  AI_LLM: 'Content generation and analysis run by a model.',
  DETERMINISTIC_RULE: 'Scheduled sweeps, dispatchers, and rule-based automation.',
  LOCAL_EDGE: 'Image and video assembly done on our own servers.',
};

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Bucket labels are YYYY-MM-DD strings; slice rather than parse to avoid locale drift. */
function formatBucket(bucketStart: string, granularity: UsageGranularity): string {
  if (typeof bucketStart !== 'string' || bucketStart.length < 10) return bucketStart || '—';
  if (granularity === 'monthly') return bucketStart.slice(0, 7);
  if (granularity === 'weekly') return `w/c ${bucketStart.slice(5)}`;
  return bucketStart.slice(5);
}

/** A task_key is `domain.task_name`; render it as words without losing the domain. */
function formatTaskKey(taskKey: string): string {
  if (!taskKey) return '—';
  return taskKey.replace(/[._]/g, ' ');
}

function userLabel(row: UsageAnalytics['topUsers'][number]): string {
  if (row.isSystem) return 'Automated (no person)';
  return row.name ?? `User ${row.userId}`;
}

export default function AriesUsageScreen() {
  const [granularity, setGranularity] = useState<UsageGranularity>('daily');
  const [showTokens, setShowTokens] = useState(false);
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchUsageAnalytics(granularity).then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setAnalytics(result.analytics);
        setLoadError(null);
      } else {
        setAnalytics(null);
        setLoadError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [granularity]);

  const tokensReported = analytics?.tokensReported ?? false;
  // Never plot a token line that is entirely "not reported" — that is a flat
  // zero pretending to be a measurement.
  const plotTokens = showTokens && tokensReported;
  const chartData = (analytics?.series ?? []).map((point) => ({
    bucket: formatBucket(point.bucketStart, analytics?.granularity ?? granularity),
    tasks: point.tasks,
    tokens: point.totalTokens ?? 0,
  }));

  const totalTasks = analytics?.totalTasks ?? 0;
  const totalAiTasks = analytics?.totalAiTasks ?? 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">Usage</p>
          <h1 className="text-2xl font-semibold text-white">Who is using Aries, and for what</h1>
          <p className="text-sm leading-7 text-white/55">
            Everything your workspace has run, broken down by person, task, and how it was processed.
          </p>
        </div>
        <div
          className="flex rounded-full border border-white/10 bg-white/[0.06] p-1"
          role="group"
          aria-label="Time granularity"
        >
          {GRANULARITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setGranularity(option.value)}
              aria-pressed={granularity === option.value}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                granularity === option.value
                  ? 'bg-white text-[#11161c]'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-white/60">Loading usage…</p>
      ) : loadError ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          {loadError}
        </div>
      ) : !analytics ? (
        <EmptyStatePanel
          title="No usage to show"
          description="We couldn't read your usage breakdown. Try again in a moment."
        />
      ) : !analytics.metered ? (
        // Usage isn't being recorded yet, so every number would be a wrong zero
        // rather than a missing one. Same contract as the settings quota card.
        <EmptyStatePanel
          title="Usage tracking isn't switched on yet"
          description="Once usage tracking is enabled for your workspace, this page will show consumption over time, who is running what, and how much of it is AI versus automation."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard
              label="Tasks"
              value={formatNumber(totalTasks)}
              detail={`${analytics.rangeStart} → ${analytics.rangeEnd}`}
            />
            <MetricCard
              label="AI tasks"
              value={formatNumber(totalAiTasks)}
              detail={
                totalTasks > 0
                  ? `${Math.round((totalAiTasks / totalTasks) * 100)}% of all work`
                  : 'No work in this window'
              }
            />
            <MetricCard
              label="Automation"
              value={formatNumber(totalTasks - totalAiTasks)}
              detail="Rule-based and local compute"
            />
            <MetricCard
              label="Tokens"
              value={tokensReported ? formatNumber(analytics.totalTokens) : 'Not reported'}
              detail={
                tokensReported
                  ? `${formatNumber(analytics.totalAiTasksWithUsage)} of ${formatNumber(totalAiTasks)} AI tasks reported usage`
                  : 'Token usage is not reported back to Aries yet'
              }
            />
          </div>

          <ShellPanel
            eyebrow="Over time"
            title={plotTokens ? 'Tokens per period' : 'Tasks per period'}
            action={
              <button
                type="button"
                onClick={() => setShowTokens((current) => !current)}
                disabled={!tokensReported}
                title={
                  tokensReported ? undefined : 'Token usage is not reported back to Aries yet.'
                }
                className="rounded-full border border-white/12 px-4 py-2 text-sm font-medium text-white/80 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {showTokens ? 'Show tasks' : 'Show tokens'}
              </button>
            }
          >
            {chartData.length > 0 ? (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 12, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                      minTickGap={16}
                    />
                    <YAxis tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }} width={56} />
                    <Tooltip
                      contentStyle={{
                        background: '#0f151b',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 12,
                        color: '#fff',
                      }}
                    />
                    {/* One series, so no legend box — the panel title names it. */}
                    <Line
                      type="monotone"
                      dataKey={plotTokens ? 'tokens' : 'tasks'}
                      name={plotTokens ? 'Tokens' : 'Tasks'}
                      stroke="#a78bfa"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-white/55">Nothing ran in this window yet.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="People" title="Who is running the most">
            {analytics.topUsers.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">Member</th>
                      <th className="py-3 pr-4 text-right font-semibold">Tasks</th>
                      <th className="py-3 pr-4 text-right font-semibold">AI tasks</th>
                      <th className="py-3 text-right font-semibold">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topUsers.map((row) => (
                      <tr key={row.userId} className="border-b border-white/[0.06] text-white/75">
                        <td className="py-3 pr-4 text-white/90">{userLabel(row)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.tasks)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.aiTasks)}</td>
                        <td className="py-3 text-right">
                          {row.aiTasksWithUsage > 0 ? formatNumber(row.totalTokens) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* The userless row is the majority of real work, so say why it
                    exists rather than letting it read as one very busy person. */}
                <p className="mt-4 text-sm leading-7 text-white/55">
                  Scheduled and background work isn&apos;t started by a person, so it&apos;s grouped
                  as &ldquo;Automated&rdquo;.
                  {tokensReported
                    ? ''
                    : ' Token columns stay blank until token usage is reported back to Aries.'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-white/55">No attributed usage in this window yet.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Tasks" title="Slowest tasks by average run time">
            {analytics.slowestTasks.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">Task</th>
                      <th className="py-3 pr-4 text-right font-semibold">Runs</th>
                      <th className="py-3 pr-4 text-right font-semibold">Average</th>
                      <th className="py-3 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.slowestTasks.map((row) => (
                      <tr key={row.taskKey} className="border-b border-white/[0.06] text-white/75">
                        <td className="py-3 pr-4 text-white/90">{formatTaskKey(row.taskKey)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.executions)}</td>
                        <td className="py-3 pr-4 text-right">{formatDuration(row.avgDurationMs)}</td>
                        <td className="py-3 text-right">{formatDuration(row.totalDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-white/55">No task timings in this window yet.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Processing" title="AI versus automation">
            {analytics.engineSplit.length > 0 ? (
              <div className="space-y-4">
                {analytics.engineSplit.map((row) => {
                  const share = totalTasks > 0 ? Math.round((row.tasks / totalTasks) * 100) : 0;
                  return (
                    <div key={row.engine} className="space-y-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="flex items-center gap-2 text-sm font-medium text-white">
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: ENGINE_COLORS[row.engine] ?? 'rgba(255,255,255,0.45)' }}
                          />
                          {ENGINE_LABELS[row.engine] ?? row.engine}
                        </p>
                        <p className="text-sm text-white/70">
                          {formatNumber(row.tasks)} tasks · {share}%
                        </p>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, share))}%`,
                            background: ENGINE_COLORS[row.engine] ?? 'rgba(255,255,255,0.45)',
                          }}
                        />
                      </div>
                      <p className="text-sm leading-7 text-white/55">
                        {ENGINE_DETAIL[row.engine] ?? 'Other processing.'}{' '}
                        {formatDuration(row.totalDurationMs)} of processing time.
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-white/55">Nothing ran in this window yet.</p>
            )}
          </ShellPanel>
        </>
      )}
    </div>
  );
}
