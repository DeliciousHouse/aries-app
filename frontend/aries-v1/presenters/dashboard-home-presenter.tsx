'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import {
  ArrowRight,
  CheckCheck,
  ChevronRight,
  Globe2,
  Layers3,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';

import { StatusChip } from '@/frontend/aries-v1/components';
import type { DashboardHomeViewModel } from '@/frontend/aries-v1/view-models/dashboard-home';

export interface DashboardHomePresenterProps {
  model: DashboardHomeViewModel;
  channelsState?: 'loading' | 'ready' | 'error';
  channelsErrorMessage?: string | null;
  /** When set, connected channels with `canDisconnect` show a Disconnect control. */
  onChannelDisconnect?: (channelId: string) => void;
  /** e.g. `instagram:disconnect` while a disconnect request is in flight */
  channelsBusyAction?: string | null;
}

type OrbitSurface = {
  label: string;
  value: string;
  supporting: string;
  icon: typeof Layers3;
  glow: string;
};

export default function DashboardHomePresenter({
  model,
  channelsState = 'ready',
  channelsErrorMessage,
  onChannelDisconnect,
  channelsBusyAction,
}: DashboardHomePresenterProps) {
  const surfaces = useMemo<OrbitSurface[]>(() => {
    const metricByLabel = (label: string) =>
      model.hero.metrics.find((metric) => metric.label === label);
    const campaignsMetric = metricByLabel('Campaigns');
    const approvalsMetric = metricByLabel('Pending approvals');
    const publishMetric = metricByLabel('Ready to publish');
    const channelsMetric = metricByLabel('Connected channels');
    const profileMetric = metricByLabel('Profile status');

    return [
      {
        label: 'Campaigns',
        value: campaignsMetric?.value || '0',
        supporting: model.activeCampaign ? model.activeCampaign.stageLabel : 'No active campaign',
        icon: Layers3,
        glow: 'rgba(123,97,255,0.28)',
      },
      {
        label: 'Approvals',
        value: approvalsMetric?.value || String(model.reviews.count),
        supporting: model.reviews.count > 0 ? 'Waiting on review' : 'Queue is clear',
        icon: CheckCheck,
        glow: 'rgba(229,192,123,0.3)',
      },
      {
        label: 'Channels',
        value: channelsMetric?.value || String(model.channels.connectedCount),
        supporting:
          model.channels.attentionCount > 0
            ? `${model.channels.attentionCount} need attention`
            : model.channels.connectedCount > 0
              ? 'Connected and monitored'
              : 'Not connected yet',
        icon: Globe2,
        glow: 'rgba(56,189,248,0.28)',
      },
      {
        label: 'Profile',
        value: profileMetric?.value || 'Unavailable',
        supporting: model.readiness[0]?.detail || 'Business context unavailable',
        icon: ShieldCheck,
        glow: 'rgba(52,211,153,0.26)',
      },
      model.workingNow.mode === 'publish'
        ? {
            label: 'Ready',
            value: publishMetric?.value || String(model.publish.count),
            supporting:
              model.publish.pausedCount > 0
                ? `${model.publish.pausedCount} paused in Meta`
                : model.publish.count > 0
                  ? `${model.publish.count} ready now`
                  : 'Waiting on publish-ready work',
            icon: Sparkles,
            glow: 'rgba(192,132,252,0.24)',
          }
        : {
            label: 'Results',
            value: String(model.results.items.length),
            supporting: model.results.items.length > 0 ? 'Live signal available' : 'Waiting on live activity',
            icon: Zap,
            glow: 'rgba(244,114,182,0.24)',
          },
    ];
  }, [model]);

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (surfaces.length <= 1) {
      return;
    }

    const interval = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % surfaces.length);
    }, 4000);

    return () => window.clearInterval(interval);
  }, [surfaces.length]);

  useEffect(() => {
    setActiveIndex((current) => current % Math.max(surfaces.length, 1));
  }, [surfaces.length]);

  const activeSurface = surfaces[activeIndex] || surfaces[0];

  return (
    <div className="space-y-12 pb-12">
      <section className="relative min-h-[min(88vh,820px)] overflow-hidden rounded-[2rem] border border-white/10 bg-[radial-gradient(ellipse_at_bottom,rgba(123,97,255,0.16),transparent_45%),linear-gradient(180deg,#0a0a0f_0%,#050505_100%)] shadow-[0_24px_80px_rgba(0,0,0,0.42)] md:min-h-[550px] lg:min-h-[550px]">
        <div className="absolute right-5 top-5 z-40 md:right-8 md:top-8">
          <div className="rounded-xl border border-white/10 bg-[#12121a] px-3 py-2 shadow-xl md:rounded-2xl md:px-6 md:py-4">
            <h2 className="text-sm font-bold tracking-tight text-white md:text-2xl">{model.hero.title}</h2>
          </div>
        </div>

        <div className="absolute inset-0 flex items-end justify-center">
          <div className="absolute top-28 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center text-center md:top-32 lg:top-16">
            <motion.span
              key={activeSurface.value}
              initial={{ opacity: 0, filter: 'blur(4px)', y: 6 }}
              animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
              transition={{ duration: 0.45 }}
              className="text-2xl font-bold tracking-tight text-white sm:text-4xl md:text-3xl lg:text-3xl"
            >
              {activeSurface.value}
            </motion.span>
            <span className="mt-2 text-[10px] font-medium uppercase tracking-[0.32em] text-white/45 md:text-xs">
              {activeSurface.label}
            </span>
          </div>

          <div className="absolute bottom-0 w-[94%] max-w-[1040px] overflow-visible md:w-[82%]">
            <svg viewBox="0 0 200 100" className="w-full overflow-visible">
              <defs>
                <linearGradient id="dashboardOrbitTicks" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(123,97,255,0.08)" />
                  <stop offset="50%" stopColor="rgba(123,97,255,0.48)" />
                  <stop offset="100%" stopColor="rgba(123,97,255,0.08)" />
                </linearGradient>
              </defs>
              <g transform="translate(100, 100)">
                {Array.from({ length: 90 }).map((_, index) => (
                  <line
                    key={index}
                    x1="0"
                    y1="-84"
                    x2="0"
                    y2="-95"
                    transform={`rotate(${(index * 180) / 89 - 90})`}
                    stroke="url(#dashboardOrbitTicks)"
                    strokeWidth="0.75"
                  />
                ))}
              </g>
              <circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
              <circle cx="100" cy="100" r="50" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            </svg>

            <div className="pointer-events-none absolute bottom-0 left-1/2 aspect-square w-[78%] -translate-x-1/2 translate-y-1/2 md:w-[62%]">
              <motion.div
                className="absolute inset-0"
                animate={{ rotate: activeIndex * 72 }}
                transition={{ duration: 1.5, ease: 'easeInOut' }}
              >
                {surfaces.map((surface, index) => {
                  const isActive = index === activeIndex;
                  const Icon = surface.icon;
                  return (
                    <div
                      key={surface.label}
                      className="absolute inset-0"
                      style={{ transform: `rotate(${-index * 72}deg)` }}
                    >
                      <div className="absolute top-0 left-1/2 h-0 w-0">
                        <motion.div
                          animate={{ rotate: -(activeIndex * 72 - index * 72) }}
                          transition={{ duration: 1.5, ease: 'easeInOut' }}
                          className={`-ml-6 -mt-6 flex h-12 w-12 items-center justify-center rounded-full border bg-[#12121a] transition-all duration-500 md:-ml-7 md:-mt-7 md:h-14 md:w-14 ${
                            isActive ? 'border-white/30 text-white' : 'border-white/10 text-white/45'
                          }`}
                          style={{
                            boxShadow: isActive ? `0 0 30px ${surface.glow}` : 'none',
                          }}
                        >
                          <Icon className="h-5 w-5 md:h-6 md:w-6" />
                        </motion.div>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </div>
          </div>

          <div className="absolute bottom-0 z-30 flex aspect-[1.7/1] w-[58%] max-w-[460px] items-end justify-center rounded-t-full border-t border-primary/40 bg-gradient-to-t from-[#050505] to-primary/25 pb-5 shadow-[0_-30px_60px_rgba(123,97,255,0.18)] sm:aspect-[2/1] sm:w-[52%] sm:pb-5 md:w-[38%] md:pb-8">
            <div className="flex flex-col items-center text-center">
              <motion.span
                key={activeSurface.supporting}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.45 }}
                className="max-w-[12rem] text-sm font-semibold text-white md:max-w-[10rem] md:text-sm lg:max-w-[15rem] lg:text-2xl"
              >
                {activeSurface.supporting}
              </motion.span>
              <span className="mt-2 text-[9px] uppercase tracking-[0.28em] text-white/45 md:text-[9px] lg:text-[11px]">
                Current focus
              </span>
            </div>
          </div>
        </div>

        <div className="absolute inset-0 z-40 grid grid-cols-1 items-end justify-items-center gap-3 p-4 pb-8 sm:gap-4 sm:p-5 sm:pb-10 md:grid-cols-2 md:items-end md:justify-items-stretch md:gap-3 md:gap-x-4 md:p-4 md:pb-8 lg:grid-cols-12 lg:gap-6 lg:p-6 lg:pb-6">
          <div className="hidden w-full max-w-[min(100%,22rem)] sm:max-w-md md:block md:max-w-[13rem] md:justify-self-start lg:col-span-3 lg:max-w-none lg:w-full lg:justify-self-start lg:self-end">
            <HeroSideCard eyebrow="Next Action" title={model.nextAction.title} detail={model.nextAction.summary}>
              <Link
                href={model.nextAction.href}
                className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/75"
              >
                {model.nextAction.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </HeroSideCard>
          </div>

          <div className="hidden lg:col-span-6 lg:block" />

          <div className="hidden w-full max-w-[min(100%,22rem)] sm:max-w-md md:block md:max-w-[13rem] md:justify-self-end lg:col-span-3 lg:max-w-none lg:w-full lg:justify-self-end lg:self-end">
            <HeroSideCard
              eyebrow="Campaign Focus"
              title={model.activeCampaign?.name || 'No active campaign yet'}
              detail={model.activeCampaign?.summary || 'Create a campaign and Aries will start grounding this surface in live runtime data.'}
            >
              {model.activeCampaign ? (
                <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                  <span>{model.activeCampaign.stageLabel}</span>
                  <span>{model.activeCampaign.pendingApprovals} pending approvals</span>
                </div>
              ) : null}
            </HeroSideCard>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="overflow-hidden rounded-2xl border border-white/[0.05] bg-[#080808]"
        >
          <div className="flex items-start justify-between p-6 pb-5">
            <div>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/40">Working Now</h4>
              <h3 className="text-xl font-semibold tracking-tight text-white">{model.workingNow.title}</h3>
            </div>
            <Link href={model.workingNow.href} className="flex items-center gap-1 text-sm font-medium text-white/90 transition-colors hover:text-white">
              {model.workingNow.label}
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="h-px w-full bg-white/10" />

          <div className="space-y-4 p-6">
            <p className="text-[15px] leading-relaxed text-white/60">{model.workingNow.summary}</p>

            {model.workingNow.items.length > 0 ? (
              <div className="space-y-3">
                {model.workingNow.items.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-center justify-between gap-4 rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5 transition-colors hover:bg-[#231a2f]"
                  >
                    <div>
                      <span className="mb-1 block text-[15px] font-medium text-white/90">{item.title}</span>
                      <span className="text-sm text-white/40">{item.meta}</span>
                    </div>
                    <StatusChip status={item.status} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
                    <Sparkles className="h-5 w-5 text-white/90" />
                  </div>
                  <div>
                    <h4 className="mb-2 text-[15px] font-semibold text-white">
                      {model.nextAction.title}
                    </h4>
                    <p className="mb-4 text-[14px] leading-relaxed text-white/50">{model.nextAction.summary}</p>
                    <Link
                      href={model.nextAction.href}
                      className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/80"
                    >
                      {model.nextAction.label}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="overflow-hidden rounded-2xl border border-white/[0.05] bg-[#080808]"
        >
          <div className="flex items-start justify-between p-6 pb-5">
            <div>
              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/40">Needs Approval</h4>
              <h3 className="text-xl font-semibold tracking-tight text-white">
                {model.reviews.count > 0 ? `${model.reviews.count} items waiting` : 'Approval queue is clear'}
              </h3>
            </div>
            <Link
              href="/review"
              className="flex items-center gap-2 rounded-full border border-[#4a4025] bg-[#2a2515] px-4 py-2 text-white transition-colors hover:bg-[#352e18]"
            >
              <Layers3 className="h-4 w-4 text-[#e5c07b]" />
              <span className="text-sm font-medium">Review Queue</span>
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white">
                {model.reviews.count}
              </span>
            </Link>
          </div>
          <div className="h-px w-full bg-white/10" />

          <div className="space-y-4 p-6">
            {model.reviews.items.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5 text-sm leading-relaxed text-white/55">
                Nothing is waiting on approval right now. New review items will appear here when they are ready for a decision.
              </div>
            ) : (
              model.reviews.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="flex items-center justify-between rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5 transition-colors hover:bg-[#231a2f]"
                >
                  <div>
                    <span className="mb-1 block text-[15px] font-medium text-white/90">{item.title}</span>
                    <span className="text-sm text-white/40">{item.meta}</span>
                  </div>
                  <div className="rounded-full border border-[#4a4025] bg-[#2a2515]/50 px-3 py-1 text-xs font-medium text-[#e5c07b]">
                    {item.status === 'changes_requested' ? 'Needs changes' : 'In review'}
                  </div>
                </Link>
              ))
            )}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="overflow-hidden rounded-2xl border border-white/[0.05] bg-[#080808]"
        >
          <div className="p-6 pb-5">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/40">Operational Readiness</h4>
            <h3 className="text-xl font-semibold tracking-tight text-white">What Aries is watching closely</h3>
          </div>
          <div className="h-px w-full bg-white/10" />

          <div className="space-y-4 p-6">
            {model.readiness.map((item) => (
              <div key={item.label} className="flex items-start gap-4 rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5">
                <div
                  className={`mt-1 h-10 w-10 shrink-0 rounded-full border ${
                    item.tone === 'good'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                      : item.tone === 'watch'
                        ? 'border-[#4a4025] bg-[#2a2515] text-[#e5c07b]'
                        : 'border-white/10 bg-white/10 text-white/60'
                  } flex items-center justify-center`}
                >
                  {item.tone === 'good' ? <ShieldCheck className="h-4 w-4" /> : item.tone === 'watch' ? <CheckCheck className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                </div>
                <div>
                  <div className="mb-1 flex flex-wrap items-baseline gap-2">
                    <span className="text-[15px] font-medium text-white/90">{item.label}</span>
                    <span className="text-xs uppercase tracking-[0.22em] text-white/35">{item.value}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-white/50">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.26 }}
          className="overflow-hidden rounded-2xl border border-white/[0.06] bg-black"
        >
          <div className="p-6 pb-5">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/40">Connected Surfaces</h4>
            <h3 className="text-xl font-semibold tracking-tight text-white">Publishing and monitoring health</h3>
          </div>
          <div className="h-px w-full bg-white/[0.08]" />

          <div className="p-6">
            {channelsState === 'loading' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={index}
                    className="flex min-h-[132px] animate-pulse flex-col rounded-xl border border-white/[0.06] bg-[#1a1a24] p-3"
                  >
                    <div className="mb-2.5 flex justify-end">
                      <div className="h-2 w-2 shrink-0 rounded-full bg-white/[0.08]" />
                    </div>
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 shrink-0 rounded-lg bg-white/[0.06]" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="h-4 w-3/5 rounded bg-white/[0.06]" />
                        <div className="h-3 w-2/5 rounded bg-white/[0.04]" />
                      </div>
                    </div>
                    <div className="mt-auto flex-1" />
                    <div className="mt-3 h-9 w-full rounded-lg bg-white/[0.06]" />
                  </div>
                ))}
              </div>
            ) : channelsState === 'error' && model.channels.items.length === 0 ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-100">
                {channelsErrorMessage || 'Unable to load channel health.'}
              </div>
            ) : model.channels.items.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] bg-[#1a1a24] p-5 text-sm leading-relaxed text-white/55">
                No channel connections yet. Connect platforms in Settings when you are ready to schedule or monitor launches.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {model.channels.items.map((channel) => {
                  const statusDot =
                    channel.health === 'connected'
                      ? 'bg-[#4ade80]'
                      : channel.health === 'attention'
                        ? 'bg-amber-400'
                        : 'bg-white/35';
                  const statusLabel =
                    channel.health === 'connected'
                      ? 'Connected'
                      : channel.health === 'attention'
                        ? 'Needs attention'
                        : 'Not connected';
                  const statusText =
                    channel.health === 'connected'
                      ? 'text-[#4ade80]'
                      : channel.health === 'attention'
                        ? 'text-amber-300'
                        : 'text-white/55';

                  const disconnectBusy = channelsBusyAction === `${channel.id}:disconnect`;

                  const showHandle =
                    channel.handle.trim() !== '' &&
                    channel.handle.trim().toLowerCase() !== channel.name.trim().toLowerCase();

                  return (
                    <div
                      key={channel.id}
                      className="group/channel-card flex min-h-[132px] flex-col rounded-xl border border-white/[0.08] bg-[#1a1a24] p-3"
                    >
                      <div className="mb-2.5 flex w-full justify-end" role="status" aria-label={statusLabel}>
                        <div className="flex cursor-default items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-0 transition-[padding] duration-200 ease-out group-hover/channel-card:pr-1.5 group-focus-within/channel-card:pr-1.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} aria-hidden />
                          <span
                            className={`max-w-0 overflow-hidden whitespace-nowrap text-xs font-medium leading-tight opacity-0 transition-[max-width,opacity] duration-200 ease-out ${statusText} group-hover/channel-card:max-w-[10rem] group-hover/channel-card:opacity-100 group-focus-within/channel-card:max-w-[10rem] group-focus-within/channel-card:opacity-100`}
                          >
                            {statusLabel}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5">
                        {channelPlatformIcon(channel.id)}
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-semibold leading-snug text-white">{channel.name}</p>
                          {showHandle ? (
                            <p className="mt-0.5 truncate text-xs text-white/45">{channel.handle}</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex-1" aria-hidden />
                      {channel.health !== 'connected' ? (
                        <Link
                          href={`/oauth/connect/${encodeURIComponent(channel.id)}?mode=${channel.health === 'attention' ? 'reconnect' : 'connect'}`}
                          className="mt-3 box-border flex w-full min-h-[2.5rem] shrink-0 items-center justify-center rounded-lg border border-transparent bg-[#2a2a35] px-3 text-center text-[0.9rem] font-medium text-white transition-colors hover:bg-[#34343f]"
                        >
                          {channel.health === 'attention' ? 'Reconnect' : 'Connect'}
                        </Link>
                      ) : channel.canDisconnect && onChannelDisconnect ? (
                        <button
                          type="button"
                          disabled={disconnectBusy}
                          onClick={() => onChannelDisconnect(channel.id)}
                          className="mt-3 box-border flex w-full min-h-[2.125rem] shrink-0 items-center justify-center rounded-lg border border-red-500/75 bg-transparent px-3 py-1.5 text-center text-[0.9rem] font-medium leading-tight text-red-200/95 transition-colors hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}

function channelPlatformIcon(platformId: string) {
  const id = platformId.toLowerCase();
  const wrap = 'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg';

  switch (id) {
    case 'facebook':
      return (
        <div className={`${wrap} bg-[#1877F2]`} aria-hidden>
          <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
          </svg>
        </div>
      );
    case 'instagram':
      return (
        <div
          className={`${wrap} bg-gradient-to-br from-[#833AB4] via-[#FD1D1D] to-[#F77737]`}
          aria-hidden
        >
          <svg className="h-[18px] w-[18px] text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
          </svg>
        </div>
      );
    case 'linkedin':
      return (
        <div className={`${wrap} bg-[#0A66C2]`} aria-hidden>
          <svg className="h-[18px] w-[18px] text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
          </svg>
        </div>
      );
    case 'x':
      return (
        <div className={`${wrap} bg-black`} aria-hidden>
          <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>
      );
    case 'youtube':
      return (
        <div className={`${wrap} bg-[#FF0000]`} aria-hidden>
          <svg className="h-[18px] w-[18px] text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
          </svg>
        </div>
      );
    case 'tiktok':
      return (
        <div className={`${wrap} bg-black ring-1 ring-white/15`} aria-hidden>
          <svg className="h-[18px] w-[18px] text-[#25F4EE]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.81 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
          </svg>
        </div>
      );
    case 'reddit':
      return (
        <div className={`${wrap} bg-[#FF4500]`} aria-hidden>
          <svg className="h-[18px] w-[18px] text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.872-7.004 4.872-3.874 0-7.004-2.178-7.004-4.872 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.486l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.922.916 2.156 1.41 3.474 1.41 1.318 0 2.55-.494 3.474-1.41a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.793.79-1.851 1.212-2.997 1.212-1.146 0-2.206-.422-2.998-1.212a.327.327 0 0 0-.24-.094z" />
          </svg>
        </div>
      );
    default:
      return (
        <div className={`${wrap} bg-white/10`} aria-hidden>
          <Globe2 className="h-[18px] w-[18px] text-white/80" />
        </div>
      );
  }
}

function HeroSideCard(props: {
  eyebrow: string;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-5 shadow-2xl backdrop-blur-xl transition-colors hover:bg-white/[0.07]"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/15 blur-[56px]" />
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.eyebrow}</p>
      <h3 className="mb-3 text-lg font-semibold text-white">{props.title}</h3>
      <p className="text-sm leading-relaxed text-white/55">{props.detail}</p>
      {props.children ? <div className="mt-4">{props.children}</div> : null}
    </motion.div>
  );
}
