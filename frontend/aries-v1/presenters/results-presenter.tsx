'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Layers3,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { ResultsViewModel } from '@/frontend/aries-v1/view-models/results';

export interface ResultsPresenterProps {
  model: ResultsViewModel;
}

export default function ResultsPresenter({ model }: ResultsPresenterProps) {
  const [activeFilter, setActiveFilter] = useState<ResultsViewModel['filters'][number]['id']>('all');

  const filteredCampaigns = useMemo(() => {
    switch (activeFilter) {
      case 'needs_review':
        return model.campaigns.filter((campaign) => campaign.needsReview);
      case 'all':
        return model.campaigns;
      default:
        return model.campaigns.filter((campaign) => campaign.status === activeFilter);
    }
  }, [activeFilter, model.campaigns]);

  const statusChartData = model.statusBreakdown.filter((entry) => entry.count > 0);
  const pieData = statusChartData.map((entry) => ({ name: entry.label, value: entry.count, color: entry.color }));

  return (
    <div className="flex flex-col gap-8 pb-12 lg:flex-row">
      <aside className="w-full shrink-0 space-y-2 lg:w-64">
        <h3 className="mb-4 px-2 text-xs font-bold uppercase tracking-[0.28em] text-zinc-500">Segments</h3>
        <div className="flex gap-2 overflow-x-auto pb-4 no-scrollbar lg:flex-col lg:overflow-visible lg:pb-0">
          {model.filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setActiveFilter(filter.id)}
              className={`flex shrink-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-all lg:w-full ${
                activeFilter === filter.id
                  ? 'border-primary bg-primary/10 text-white shadow-[0_0_15px_rgba(123,97,255,0.2)]'
                  : 'border-white/5 bg-white/[0.02] text-zinc-400 hover:border-white/10 hover:bg-white/[0.04] hover:text-white'
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: filter.color }}
                />
                <span className="text-sm font-medium whitespace-nowrap">{filter.label}</span>
              </div>
              <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs font-semibold text-white/85">
                {filter.count}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-6 hidden lg:block">
          <div className="glass-panel border-primary/10 bg-primary/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Sparkles className="h-4 w-4" />
              <span className="text-xs font-bold uppercase tracking-[0.2em]">Operator insight</span>
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-400">
              This is still an operational results layer, not a fabricated analytics board. The restored presentation is richer, but the numbers remain grounded in live campaign state.
            </p>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-8">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div>
            <div className="mb-2 flex items-center gap-3">
              <div className="rounded-lg bg-white/5 p-2">
                <BarChart3 className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-3xl font-display font-semibold tracking-tight text-white">
                Results
              </h1>
            </div>
            <p className="max-w-3xl text-zinc-500">{model.hero.description}</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75">
            <Layers3 className="h-4 w-4 text-primary" />
            {filteredCampaigns.length} campaign{filteredCampaigns.length === 1 ? '' : 's'} in view
          </div>
        </div>

        {model.campaigns.length === 0 ? (
          <div className="glass-panel p-8">
            <h2 className="text-2xl font-semibold text-white">Nothing to report yet</h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
              Campaign results will begin to appear here once runtime-backed campaigns are created and start moving through the workflow.
            </p>
            <Link
              href="/dashboard/campaigns"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)]"
            >
              Open campaign list
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {model.hero.metrics.map((metric, index) => (
                <motion.div
                  key={metric.label}
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.08 }}
                  className="glass-panel group p-5"
                >
                  <div className="mb-4 flex items-start justify-between">
                    <div className="rounded-xl bg-white/5 p-2 text-zinc-500 transition-colors group-hover:text-primary">
                      {index === 0 ? <Layers3 className="h-5 w-5" /> : index === 1 ? <TrendingUp className="h-5 w-5" /> : index === 2 ? <Clock3 className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                    </div>
                    <div className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                      metric.tone === 'good'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : metric.tone === 'watch'
                          ? 'bg-amber-500/10 text-amber-300'
                          : 'bg-white/5 text-zinc-400'
                    }`}>
                      {metric.label}
                    </div>
                  </div>
                  <div>
                    <h3 className="mb-1 text-3xl font-display font-semibold text-white">{metric.value}</h3>
                    <p className="text-sm leading-relaxed text-zinc-400">{metric.detail}</p>
                  </div>
                </motion.div>
              ))}
            </div>

            <motion.section
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="glass-panel p-5 md:p-8"
            >
              <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
                <div>
                  <h2 className="text-lg font-semibold text-white">Campaign status mix</h2>
                  <p className="text-xs text-zinc-500">A live view of how the current campaign portfolio is distributed right now.</p>
                </div>
                <div className="flex flex-wrap gap-3 text-[10px] font-bold uppercase tracking-[0.22em]">
                  {statusChartData.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                      <span className="text-zinc-500">{entry.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-[280px] w-full md:h-[360px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusChartData} margin={{ top: 12, right: 10, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="label" stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                      contentStyle={{
                        backgroundColor: '#12121a',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderRadius: '14px',
                        color: '#fff',
                        fontSize: '12px',
                      }}
                    />
                    <Bar dataKey="count" radius={[10, 10, 0, 0]}>
                      {statusChartData.map((entry) => (
                        <Cell key={entry.id} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]">
              <motion.section
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.38 }}
                className="glass-panel p-6"
              >
                <h2 className="mb-6 text-lg font-semibold text-white">Portfolio distribution</h2>
                <div className="grid gap-6 md:grid-cols-[0.95fr_1.05fr]">
                  <div className="h-[240px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={56}
                          outerRadius={88}
                          paddingAngle={3}
                        >
                          {pieData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#12121a',
                            borderColor: 'rgba(255,255,255,0.1)',
                            borderRadius: '14px',
                            color: '#fff',
                            fontSize: '12px',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="space-y-3">
                    {model.stageBreakdown.length === 0 ? (
                      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 text-sm text-zinc-500">
                        Stage breakdown will appear once campaigns move through the runtime.
                      </div>
                    ) : (
                      model.stageBreakdown.map((stage) => (
                        <div
                          key={stage.label}
                          className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.02] p-3"
                        >
                          <div>
                            <p className="text-sm font-medium text-white">{stage.label}</p>
                            <p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Current stage</p>
                          </div>
                          <span className="text-sm font-semibold text-white">{stage.count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.46 }}
                className="glass-panel p-6"
              >
                <div className="mb-6 flex items-center justify-between gap-4">
                  <h2 className="text-lg font-semibold text-white">Campaign roster</h2>
                  <Link
                    href="/dashboard/campaigns"
                    className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/75"
                  >
                    Open campaigns
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
                <div className="space-y-4">
                  {filteredCampaigns.length === 0 ? (
                    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm leading-relaxed text-zinc-500">
                      No campaigns match the selected segment right now.
                    </div>
                  ) : (
                    filteredCampaigns.map((campaign) => (
                      <Link
                        key={campaign.id}
                        href={campaign.href}
                        className="block rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 transition-all hover:border-primary/20 hover:bg-primary/[0.04]"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-3">
                              <h3 className="text-lg font-semibold text-white">{campaign.name}</h3>
                              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusPill(campaign.status)}`}>
                                {campaign.status === 'changes_requested' ? 'Needs changes' : campaign.status.replace('_', ' ')}
                              </span>
                            </div>
                            <p className="max-w-2xl text-sm leading-relaxed text-white/55">{campaign.summary}</p>
                          </div>
                          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75">
                            {campaign.updatedLabel}
                          </span>
                        </div>

                        <div className="mt-5 grid gap-3 md:grid-cols-3">
                          <InfoRow label="Objective" value={campaign.objective} />
                          <InfoRow label="Next scheduled" value={campaign.nextScheduled} />
                          <InfoRow label="Pending approvals" value={campaign.pendingApprovals} />
                        </div>

                        <div className="mt-5 rounded-2xl border border-primary/10 bg-primary/5 p-4 text-sm leading-relaxed text-white/60">
                          {campaign.trustNote}
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </motion.section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function statusPill(status: ResultsViewModel['campaigns'][number]['status']) {
  if (status === 'live') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
  if (status === 'scheduled') return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
  if (status === 'approved') return 'border-indigo-400/25 bg-indigo-400/10 text-indigo-100';
  if (status === 'in_review') return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
  if (status === 'changes_requested') return 'border-rose-400/25 bg-rose-400/10 text-rose-100';
  return 'border-white/15 bg-white/7 text-white/75';
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm text-white/80">{props.value}</p>
    </div>
  );
}
