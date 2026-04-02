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
            : 'Publishing surfaces healthy',
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
    <div className="space-y-6 pb-12">
      <section className="relative min-h-[430px] overflow-hidden rounded-[2rem] border border-white/10 bg-[radial-gradient(ellipse_at_bottom,rgba(123,97,255,0.16),transparent_45%),linear-gradient(180deg,#0a0a0f_0%,#050505_100%)] shadow-[0_24px_80px_rgba(0,0,0,0.42)]">
        <div className="absolute right-5 top-5 z-40 md:right-8 md:top-8">
          <div className="space-y-3">
            <div className="rounded-xl border border-white/10 bg-[#12121a] px-3 py-2 shadow-xl md:rounded-2xl md:px-6 md:py-4">
              <h2 className="text-sm font-bold tracking-tight text-white md:text-2xl">{model.hero.title}</h2>
            </div>
            <Link
              href="/dashboard/campaigns/new"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#dcb58f]/30 bg-[#dcb58f] px-4 py-3 text-sm font-semibold text-[#11161c] shadow-[0_10px_30px_rgba(220,181,143,0.25)] transition hover:translate-y-[-1px] hover:shadow-[0_14px_36px_rgba(220,181,143,0.32)]"
            >
              New Campaign
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="absolute inset-0 flex items-end justify-center">
          <div className="absolute top-28 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center text-center md:top-16">
            <motion.span
              key={activeSurface.value}
              initial={{ opacity: 0, filter: 'blur(4px)', y: 6 }}
              animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
              transition={{ duration: 0.45 }}
              className="text-4xl font-bold tracking-tight text-white md:text-5xl"
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

          <div className="absolute bottom-0 z-30 flex aspect-[2/1] w-[52%] max-w-[460px] items-end justify-center rounded-t-full border-t border-primary/40 bg-gradient-to-t from-[#050505] to-primary/25 pb-5 shadow-[0_-30px_60px_rgba(123,97,255,0.18)] md:w-[38%] md:pb-8">
            <div className="flex flex-col items-center text-center">
              <motion.span
                key={activeSurface.supporting}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.45 }}
                className="max-w-[12rem] text-sm font-semibold text-white md:max-w-[15rem] md:text-2xl"
              >
                {activeSurface.supporting}
              </motion.span>
              <span className="mt-2 text-[9px] uppercase tracking-[0.28em] text-white/45 md:text-[11px]">
                Current focus
              </span>
            </div>
          </div>
        </div>

        <div className="relative z-40 grid h-full grid-cols-1 gap-4 p-5 md:p-6 lg:grid-cols-12 lg:gap-6">
          <div className="space-y-4 lg:col-span-3">
            <HeroSideCard eyebrow="Next Action" title={model.nextAction.title} detail={model.nextAction.summary}>
              <Link
                href={model.nextAction.href}
                className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/75"
              >
                {model.nextAction.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </HeroSideCard>

            <HeroSideCard eyebrow="Schedule Window" title={model.schedule.title} detail={model.schedule.detail}>
              {model.schedule.href ? (
                <Link
                  href={model.schedule.href}
                  className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/75"
                >
                  Open campaign schedule
                  <ChevronRight className="h-4 w-4" />
                </Link>
              ) : (
                <span className="text-sm text-white/45">Schedule signal will appear here once a launch is ready.</span>
              )}
            </HeroSideCard>
          </div>

          <div className="hidden lg:col-span-6 lg:block" />

          <div className="space-y-4 lg:col-span-3 lg:self-end">
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

            <HeroSideCard
              eyebrow="Review Queue"
              title={
                model.reviews.count > 0
                  ? `${model.reviews.count} item${model.reviews.count === 1 ? '' : 's'} waiting`
                  : 'Approval queue is clear'
              }
              detail="Nothing goes live without an explicit human decision."
            >
              <Link
                href="/review"
                className="inline-flex items-center gap-2 text-sm font-medium text-white transition-colors hover:text-white/75"
              >
                Open review queue
                <ArrowRight className="h-4 w-4" />
              </Link>
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
          className="overflow-hidden rounded-2xl border border-white/[0.05] bg-[#080808]"
        >
          <div className="p-6 pb-5">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-white/40">Connected Surfaces</h4>
            <h3 className="text-xl font-semibold tracking-tight text-white">Publishing and monitoring health</h3>
          </div>
          <div className="h-px w-full bg-white/10" />

          <div className="space-y-4 p-6">
            {channelsState === 'loading' ? (
              Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="h-28 animate-pulse rounded-2xl border border-white/[0.05] bg-[#1B1524]" />
              ))
            ) : channelsState === 'error' && model.channels.items.length === 0 ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-100">
                {channelsErrorMessage || 'Unable to load channel health.'}
              </div>
            ) : model.channels.items.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5 text-sm leading-relaxed text-white/55">
                No channel connections yet. Connect platforms in Settings when you are ready to schedule or monitor launches.
              </div>
            ) : (
              model.channels.items.map((channel) => (
                <div key={channel.id} className="rounded-2xl border border-white/[0.05] bg-[#1B1524] p-5">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="text-[15px] font-medium text-white/90">{channel.name}</span>
                    <div className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5">
                      <div
                        className={`h-2 w-2 rounded-full ${
                          channel.health === 'connected'
                            ? 'bg-emerald-400'
                            : channel.health === 'attention'
                              ? 'bg-[#e5c07b]'
                              : 'bg-white/30'
                        }`}
                      />
                      <span className="text-xs font-medium text-white/65">
                        {channel.health === 'connected'
                          ? 'Connected'
                          : channel.health === 'attention'
                            ? 'Needs attention'
                            : 'Not connected'}
                      </span>
                    </div>
                  </div>
                  <span className="mb-4 block text-sm text-white/40">{channel.handle}</span>
                  <p className="pr-4 text-sm leading-relaxed text-white/50">{channel.detail}</p>
                  {channel.health !== 'connected' ? (
                    <div className="mt-4">
                      <Link
                        href={`/oauth/connect/${encodeURIComponent(channel.id)}?mode=${channel.health === 'attention' ? 'reconnect' : 'connect'}`}
                        className="inline-flex items-center gap-2 rounded-full border border-white/[0.15] bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/10"
                      >
                        {channel.health === 'attention' ? 'Reconnect' : 'Connect'}
                      </Link>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
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
