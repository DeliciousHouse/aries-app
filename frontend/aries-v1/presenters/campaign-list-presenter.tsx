'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Rocket,
  Settings2,
  X,
} from 'lucide-react';

import type { CampaignListViewModel } from '@/frontend/aries-v1/view-models/campaign-list';

export interface CampaignListPresenterProps {
  model: CampaignListViewModel;
}

export default function CampaignListPresenter({ model }: CampaignListPresenterProps) {
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const selectedCampaign = useMemo(
    () => model.items.find((campaign) => campaign.id === selectedCampaignId) ?? null,
    [model.items, selectedCampaignId],
  );

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center md:gap-6">
        <div>
          <h1 className="mb-2 text-3xl font-display font-semibold tracking-tight text-white">Campaigns</h1>
          <p className="text-sm text-text-muted">{model.hero.description}</p>
        </div>
        <Link
          href="/onboarding/start"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-white shadow-[0_0_20px_rgba(123,97,255,0.3)] transition-all duration-300 hover:bg-primary/90 sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">New Campaign</span>
        </Link>
      </div>

      {model.items.length === 0 ? (
        <div className="glass-panel p-8 text-center">
          <h2 className="text-2xl font-semibold text-white">No campaigns yet</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
            Create the first campaign and Aries will restore this board with live runtime-backed launch state.
          </p>
          <Link
            href="/onboarding/start"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)]"
          >
            Create first campaign
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {model.items.map((campaign, index) => (
            <motion.button
              key={campaign.id}
              type="button"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.08 }}
              onClick={() => setSelectedCampaignId(campaign.id)}
              className="glass-panel group cursor-pointer p-6 text-left transition-all duration-300 hover:border-primary/30"
            >
              <div className="mb-6 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${statusIconTone(campaign.status)}`}>
                    <Rocket className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white transition-colors group-hover:text-primary">
                      {campaign.name}
                    </h3>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${statusDotTone(campaign.status)}`} />
                      <span className="text-xs capitalize text-text-muted">{statusLabel(campaign.status)}</span>
                    </div>
                  </div>
                </div>
                <span className="rounded-lg p-2 text-text-muted transition-colors group-hover:bg-white/5 group-hover:text-white">
                  <MoreVertical className="h-4 w-4" />
                </span>
              </div>

              <div className="space-y-5">
                <div>
                  <div className="mb-2 flex justify-between text-xs">
                    <span className="text-text-muted">Launch stage</span>
                    <span className="font-medium text-white">{campaign.stageLabel}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/6">
                    <div
                      className={`h-full rounded-full bg-gradient-to-r ${statusGradient(campaign.status)}`}
                      style={{ width: `${stageProgress(campaign.status)}%` }}
                    />
                  </div>
                </div>

                <p className="min-h-[3.5rem] text-sm leading-relaxed text-white/55">{campaign.summary}</p>

                <div className="grid gap-3">
                  <InfoRow label="Objective" value={campaign.objective} />
                  <InfoRow label="Next scheduled" value={campaign.nextScheduled} />
                  <InfoRow label="Pending approvals" value={campaign.pendingApprovals} />
                </div>

                <div className="flex items-center justify-between border-t border-white/8 pt-4">
                  <div className="flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5 text-text-muted" />
                    <span className="text-xs text-text-muted">{campaign.updatedLabel}</span>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75">
                    {campaign.dateRange}
                  </span>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {selectedCampaign ? (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedCampaignId(null)}
              className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed inset-0 z-50 flex h-full w-full flex-col overflow-hidden bg-[#0a0a0f] md:inset-auto md:left-1/2 md:top-1/2 md:h-auto md:max-h-[85vh] md:w-full md:max-w-4xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl md:border md:border-white/10"
            >
              <div className="flex items-start justify-between border-b border-white/10 bg-white/[0.02] p-5 md:p-6">
                <div className="flex items-center gap-4">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${statusIconTone(selectedCampaign.status)} shadow-[0_0_20px_rgba(123,97,255,0.18)]`}>
                    <Rocket className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-display font-semibold text-white">{selectedCampaign.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-text-muted">
                      <span className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        {statusLabel(selectedCampaign.status)}
                      </span>
                      <span>{selectedCampaign.updatedLabel}</span>
                      <span>{selectedCampaign.dateRange}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="rounded-lg bg-white/5 p-2 text-white transition-colors hover:bg-white/10">
                    {selectedCampaign.status === 'live' || selectedCampaign.status === 'scheduled' ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </button>
                  <Link
                    href={selectedCampaign.href}
                    className="rounded-lg bg-white/5 p-2 text-white transition-colors hover:bg-white/10"
                  >
                    <Settings2 className="h-4 w-4" />
                  </Link>
                  <button
                    type="button"
                    onClick={() => setSelectedCampaignId(null)}
                    className="ml-1 rounded-lg p-2 text-text-muted transition-colors hover:bg-white/5 hover:text-white"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-5 md:p-6">
                <div className="mb-8 grid gap-4 sm:grid-cols-3">
                  <MetricBox label="Objective" value={selectedCampaign.objective} />
                  <MetricBox label="Pending approvals" value={selectedCampaign.pendingApprovals} />
                  <MetricBox label="Next scheduled" value={selectedCampaign.nextScheduled} />
                </div>

                <div className="rounded-3xl border border-primary/15 bg-primary/5 p-5 shadow-[0_0_30px_rgba(123,97,255,0.05)]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Trust note</p>
                  <p className="mt-3 text-sm leading-relaxed text-white/65">{selectedCampaign.trustNote}</p>
                </div>

                <div className="mt-8">
                  <h3 className="mb-4 text-lg font-semibold text-white">Launch Rail</h3>
                  <div className="relative space-y-7 before:absolute before:bottom-0 before:left-5 before:top-0 before:w-px before:bg-white/10 lg:before:left-1/2 lg:before:-translate-x-px">
                    {buildTimeline(selectedCampaign).map((step) => (
                      <div
                        key={step.title}
                        className="relative flex items-center justify-between lg:justify-normal lg:odd:flex-row-reverse"
                      >
                        <div
                          className={`z-10 flex h-10 w-10 min-w-[2.5rem] items-center justify-center rounded-full border-4 border-[#0a0a0f] lg:order-1 lg:odd:-translate-x-1/2 lg:even:translate-x-1/2 ${
                            step.state === 'complete'
                              ? 'bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                              : step.state === 'active'
                                ? 'bg-primary text-white shadow-[0_0_20px_rgba(124,58,237,0.4)]'
                                : 'bg-white/5 text-white/30'
                          }`}
                        >
                          {step.state === 'complete' ? (
                            <CheckCircle2 className="h-5 w-5" />
                          ) : step.state === 'active' ? (
                            <Clock3 className="h-5 w-5" />
                          ) : (
                            <div className="h-2.5 w-2.5 rounded-full bg-white/20" />
                          )}
                        </div>
                        <div
                          className={`glass-panel w-[calc(100%-4rem)] p-5 lg:w-[calc(50%-2.5rem)] ${
                            step.state === 'active'
                              ? 'border-primary/30 bg-primary/5 shadow-[0_0_30px_rgba(124,58,237,0.05)]'
                              : step.state === 'complete'
                                ? 'border-emerald-500/20'
                                : 'border-white/5 opacity-70'
                          }`}
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <span
                              className={`text-xs font-semibold ${
                                step.state === 'complete'
                                  ? 'text-emerald-400'
                                  : step.state === 'active'
                                    ? 'text-primary'
                                    : 'text-white/40'
                              }`}
                            >
                              {step.badge}
                            </span>
                            <span className="text-xs text-white/30">{step.meta}</span>
                          </div>
                          <h4 className="mb-1 text-base font-semibold text-white">{step.title}</h4>
                          <p className="text-sm leading-relaxed text-white/50">{step.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function statusLabel(status: CampaignListViewModel['items'][number]['status']) {
  switch (status) {
    case 'in_review':
      return 'In review';
    case 'changes_requested':
      return 'Needs changes';
    default:
      return status;
  }
}

function statusIconTone(status: CampaignListViewModel['items'][number]['status']) {
  if (status === 'live') return 'bg-primary/10 text-primary';
  if (status === 'scheduled') return 'bg-sky-500/10 text-sky-300';
  if (status === 'approved') return 'bg-indigo-500/10 text-indigo-300';
  if (status === 'in_review') return 'bg-amber-500/10 text-amber-300';
  if (status === 'changes_requested') return 'bg-rose-500/10 text-rose-300';
  return 'bg-white/5 text-text-muted';
}

function statusDotTone(status: CampaignListViewModel['items'][number]['status']) {
  if (status === 'live') return 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]';
  if (status === 'scheduled') return 'bg-sky-400';
  if (status === 'approved') return 'bg-indigo-400';
  if (status === 'in_review') return 'bg-amber-400';
  if (status === 'changes_requested') return 'bg-rose-400';
  return 'bg-white/30';
}

function statusGradient(status: CampaignListViewModel['items'][number]['status']) {
  if (status === 'live') return 'from-emerald-400 to-primary';
  if (status === 'scheduled') return 'from-sky-400 to-primary';
  if (status === 'approved') return 'from-indigo-400 to-primary';
  if (status === 'in_review') return 'from-amber-400 to-primary';
  if (status === 'changes_requested') return 'from-rose-400 to-primary';
  return 'from-white/30 to-white/60';
}

function stageProgress(status: CampaignListViewModel['items'][number]['status']) {
  switch (status) {
    case 'draft':
      return 18;
    case 'changes_requested':
      return 34;
    case 'in_review':
      return 52;
    case 'approved':
      return 68;
    case 'scheduled':
      return 84;
    case 'live':
      return 100;
  }
}

function buildTimeline(campaign: CampaignListViewModel['items'][number]) {
  const reviewResolved = !campaign.needsApproval && campaign.status !== 'changes_requested' && campaign.status !== 'in_review';
  const scheduled = campaign.status === 'scheduled' || campaign.status === 'live';

  return [
    {
      title: 'Planning complete',
      badge: 'Complete',
      meta: campaign.objective,
      detail: 'The campaign brief and working objective are locked in and visible to the runtime.',
      state: 'complete' as const,
    },
    {
      title: 'Creative and approvals',
      badge: campaign.needsApproval ? 'Active' : 'Complete',
      meta: `${campaign.pendingApprovals} pending`,
      detail: campaign.needsApproval
        ? 'Human review is still required before the launch can keep moving.'
        : 'Current review checkpoints are clear for this campaign.',
      state: campaign.needsApproval ? 'active' as const : 'complete' as const,
    },
    {
      title: 'Schedule window',
      badge: scheduled ? 'Complete' : campaign.status === 'approved' ? 'Active' : 'Pending',
      meta: campaign.nextScheduled,
      detail: scheduled
        ? 'A schedule signal already exists in the live runtime.'
        : reviewResolved
          ? 'This campaign is ready for scheduling once the next publish window is chosen.'
          : 'Scheduling is blocked until approvals are resolved.',
      state: scheduled ? 'complete' as const : reviewResolved ? 'active' as const : 'pending' as const,
    },
    {
      title: 'Campaign live',
      badge: campaign.status === 'live' ? 'Live' : 'Pending',
      meta: campaign.updatedLabel,
      detail:
        campaign.status === 'live'
          ? 'This campaign is actively running and can now contribute to the Results surface.'
          : 'The campaign will show live operational signal here once it moves into a running state.',
      state: campaign.status === 'live' ? 'active' as const : 'pending' as const,
    },
  ];
}

function MetricBox(props: { label: string; value: string }) {
  return (
    <div className="glass-panel flex flex-col items-center justify-center p-4 text-center">
      <span className="text-2xl font-semibold text-white">{props.value}</span>
      <span className="mt-2 text-xs uppercase tracking-[0.22em] text-white/35">{props.label}</span>
    </div>
  );
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
      <span className="text-xs uppercase tracking-[0.22em] text-white/35">{props.label}</span>
      <span className="max-w-[14rem] text-right text-sm text-white/75">{props.value}</span>
    </div>
  );
}
