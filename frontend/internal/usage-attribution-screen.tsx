'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  fetchUsageAttribution,
  type UsageAttribution,
  type UsageAttributionQuery,
} from '@/lib/api/usage-attribution';

import { MetricCard, ShellPanel } from '@/frontend/aries-v1/components';

/**
 * AA-165 — internal usage & cost attribution.
 *
 * Deliberately outside the customer app shell and absent from
 * frontend/app-shell/routes.ts: this is staff-only, and a nav entry customers
 * can see would be both confusing and a hint worth probing. The page holds no
 * data of its own — everything comes from the allow-list-guarded API, so an
 * unauthorized visitor gets chrome and a refusal, never numbers.
 */

/** The validated dark-surface categorical set, in fixed order, never cycled. */
const ENGINE_COLORS: Record<string, string> = {
  AI_LLM: '#7c6cf0',
  DETERMINISTIC_RULE: '#12a374',
  LOCAL_EDGE: '#b45309',
};

const ENGINE_LABELS: Record<string, string> = {
  AI_LLM: 'AI',
  DETERMINISTIC_RULE: 'Rule-based',
  LOCAL_EDGE: 'Local',
};

const ENGINE_OPTIONS = [
  { value: '', label: 'All execution types' },
  { value: 'AI_LLM', label: 'AI' },
  { value: 'DETERMINISTIC_RULE', label: 'Rule-based' },
  { value: 'LOCAL_EDGE', label: 'Local' },
];

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** Cents to a currency string. null stays "—" — never $0.00 for an unknown. */
function formatMoney(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function companyLabel(row: UsageAttribution['companies'][number]): string {
  if (row.isUnscoped) return 'Unscoped platform work';
  return row.companyName ?? `Company ${row.companyId}`;
}

function utcDay(offsetDays: number): string {
  const now = new Date();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays),
  );
  return day.toISOString().slice(0, 10);
}

const INPUT_CLASS =
  'rounded-xl border border-white/12 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/30';

export default function InternalUsageAttributionScreen() {
  const [form, setForm] = useState<UsageAttributionQuery>({
    from: utcDay(-29),
    to: utcDay(0),
  });
  const [applied, setApplied] = useState<UsageAttributionQuery>(form);
  const [data, setData] = useState<UsageAttribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchUsageAttribution(applied).then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setData(result.attribution);
        setLoadError(null);
      } else {
        setData(null);
        setLoadError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  const update = useCallback(
    (key: keyof UsageAttributionQuery, value: string) =>
      setForm((current) => ({ ...current, [key]: value })),
    [],
  );

  const totalTasks = data?.totalTasks ?? 0;
  const aiShare =
    data && data.totalTasks > 0 ? Math.round((data.totalAiTasks / data.totalTasks) * 100) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
          Internal · Operations &amp; Finance
        </p>
        <h1 className="text-2xl font-semibold text-white">Usage &amp; cost attribution</h1>
        <p className="text-sm leading-7 text-white/55">
          Aggregated usage across every company, user, and execution type, with margin per client.
        </p>
      </header>

      <ShellPanel eyebrow="Filters" title="Narrow the view">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(form);
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-white/70">
            From
            <input
              type="date"
              value={form.from}
              onChange={(event) => update('from', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-white/70">
            To
            <input
              type="date"
              value={form.to}
              onChange={(event) => update('to', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-white/70">
            Company id
            <input
              inputMode="numeric"
              placeholder="All"
              value={form.companyId ?? ''}
              onChange={(event) => update('companyId', event.target.value)}
              className={`${INPUT_CLASS} w-28`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-white/70">
            User id
            <input
              inputMode="numeric"
              placeholder="All"
              value={form.userId ?? ''}
              onChange={(event) => update('userId', event.target.value)}
              className={`${INPUT_CLASS} w-28`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-white/70">
            Task type
            <input
              placeholder="All"
              value={form.taskKey ?? ''}
              onChange={(event) => update('taskKey', event.target.value)}
              className={`${INPUT_CLASS} w-56`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-white/70">
            Execution type
            <select
              value={form.engine ?? ''}
              onChange={(event) => update('engine', event.target.value)}
              className={INPUT_CLASS}
            >
              {ENGINE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#11161c]">
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#11161c]"
          >
            Apply
          </button>
        </form>
      </ShellPanel>

      {loading ? (
        <p className="text-sm text-white/60">Loading usage…</p>
      ) : loadError ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          {loadError}
        </div>
      ) : !data ? (
        <p className="text-sm text-white/60">No data.</p>
      ) : !data.metered ? (
        <div className="rounded-[1.5rem] border border-amber-400/20 bg-amber-400/10 p-5 text-amber-100">
          Usage rollups have never run on this deployment, so there is nothing to report. Enable
          ARIES_USAGE_ROLLUP_ENABLED — until then every figure here would be a zero we made up.
        </div>
      ) : (
        <>
          {data.anyModeledCost ? (
            // The single most important sentence on this page. Finance will act
            // on these numbers, so the assumption is stated where the numbers are.
            <div className="rounded-[1.5rem] border border-amber-400/20 bg-amber-400/10 p-5 text-sm leading-7 text-amber-100">
              <span className="font-semibold">Cost is modeled, not measured.</span> Hermes does not
              report token usage or cost back to Aries, so COGS is calculated from the configured
              per-task rate in <code>plan_rate_cards.cost_per_task_cents</code>. Margin figures are
              only as good as that assumption. Rows switch to measured cost automatically once real
              usage is reported.
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard
              label="Tasks"
              value={formatNumber(totalTasks)}
              detail={`${data.filters.from} → ${data.filters.to}`}
            />
            <MetricCard
              label="AI share"
              value={aiShare === null ? '—' : `${aiShare}%`}
              detail={`${formatNumber(data.totalAiTasks)} AI of ${formatNumber(totalTasks)} tasks`}
            />
            <MetricCard
              label="Billed"
              value={formatMoney(data.totalBilledPriceCents)}
              detail="Configured plan price, listed companies"
            />
            <MetricCard
              label="Margin"
              value={formatMoney(data.totalMarginCents)}
              detail={`Cost ${formatMoney(data.totalCostCents)}${data.anyModeledCost ? ' (modeled)' : ''}`}
              tone={
                data.totalMarginCents !== null && data.totalMarginCents < 0 ? 'watch' : 'default'
              }
            />
          </div>

          <ShellPanel eyebrow="Execution mix" title="AI vs rule-based vs local">
            {data.engines.length > 0 ? (
              <div className="space-y-4">
                {data.engines.map((row) => (
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
                        {formatNumber(row.tasks)} tasks · {row.sharePercent}% ·{' '}
                        {formatDuration(row.totalDurationMs)}
                      </p>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, row.sharePercent))}%`,
                          background: ENGINE_COLORS[row.engine] ?? 'rgba(255,255,255,0.45)',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-white/55">No tasks matched these filters.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Clients" title="Margin per company">
            {data.companies.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">Company</th>
                      <th className="py-3 pr-4 font-semibold">Plan</th>
                      <th className="py-3 pr-4 text-right font-semibold">Tasks</th>
                      <th className="py-3 pr-4 text-right font-semibold">AI</th>
                      <th className="py-3 pr-4 text-right font-semibold">Billed</th>
                      <th className="py-3 pr-4 text-right font-semibold">Cost</th>
                      <th className="py-3 pr-4 text-right font-semibold">Margin</th>
                      <th className="py-3 text-right font-semibold">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.companies.map((row) => (
                      <tr key={row.companyId} className="border-b border-white/[0.06] text-white/75">
                        <td className="py-3 pr-4 text-white/90">{companyLabel(row)}</td>
                        <td className="py-3 pr-4 text-white/55">{row.tierLabel ?? '—'}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.tasks)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.aiTasks)}</td>
                        <td className="py-3 pr-4 text-right">{formatMoney(row.billedPriceCents)}</td>
                        <td className="py-3 pr-4 text-right">
                          {formatMoney(row.costCents)}
                          {row.costBasis === 'modeled' ? (
                            <span className="ml-1 text-xs text-amber-200/80">est.</span>
                          ) : null}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right ${
                            row.marginCents !== null && row.marginCents < 0 ? 'text-red-300' : ''
                          }`}
                        >
                          {formatMoney(row.marginCents)}
                        </td>
                        <td className="py-3 text-right">
                          {row.marginPercent === null ? '—' : `${row.marginPercent}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-4 text-sm leading-7 text-white/55">
                  &ldquo;Unscoped platform work&rdquo; is work with no company attached — sweeps,
                  cron, and gateway callbacks. It has no plan and no margin, and is shown so the
                  totals reconcile.
                  {data.companiesTruncated
                    ? ' More companies matched than are listed; narrow the filters to see the rest.'
                    : ''}
                </p>
              </div>
            ) : (
              <p className="text-sm text-white/55">No companies matched these filters.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="People" title="Top users">
            {data.users.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">User</th>
                      <th className="py-3 pr-4 font-semibold">Company</th>
                      <th className="py-3 pr-4 text-right font-semibold">Tasks</th>
                      <th className="py-3 pr-4 text-right font-semibold">AI</th>
                      <th className="py-3 text-right font-semibold">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((row) => (
                      <tr
                        key={`${row.companyId}:${row.userId}`}
                        className="border-b border-white/[0.06] text-white/75"
                      >
                        <td className="py-3 pr-4 text-white/90">
                          {row.isSystem ? 'Automated (no person)' : (row.name ?? `User ${row.userId}`)}
                        </td>
                        <td className="py-3 pr-4 text-white/55">
                          {row.companyId === 0
                            ? 'Unscoped'
                            : (row.companyName ?? `Company ${row.companyId}`)}
                        </td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.tasks)}</td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.aiTasks)}</td>
                        <td className="py-3 text-right">{formatNumber(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-white/55">No attributed usage for these filters.</p>
            )}
          </ShellPanel>

          <ShellPanel eyebrow="Workload" title="Task types">
            {data.tasks.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                      <th className="py-3 pr-4 font-semibold">Task</th>
                      <th className="py-3 pr-4 font-semibold">Type</th>
                      <th className="py-3 pr-4 text-right font-semibold">Runs</th>
                      <th className="py-3 pr-4 text-right font-semibold">Average</th>
                      <th className="py-3 text-right font-semibold">Total time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((row) => (
                      <tr
                        key={`${row.taskKey}:${row.engine}`}
                        className="border-b border-white/[0.06] text-white/75"
                      >
                        <td className="py-3 pr-4 text-white/90">{row.taskKey}</td>
                        <td className="py-3 pr-4 text-white/55">
                          {ENGINE_LABELS[row.engine] ?? row.engine}
                        </td>
                        <td className="py-3 pr-4 text-right">{formatNumber(row.executions)}</td>
                        <td className="py-3 pr-4 text-right">{formatDuration(row.avgDurationMs)}</td>
                        <td className="py-3 text-right">{formatDuration(row.totalDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-white/55">No task activity for these filters.</p>
            )}
          </ShellPanel>
        </>
      )}
    </div>
  );
}
