import type { ComponentPropsWithoutRef } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Layers3,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';

import type {
  AriesAssetVersion,
  AriesCampaign,
  AriesCampaignStatus,
  AriesChannelConnection,
  AriesItemStatus,
  AriesKpi,
  AriesRecommendation,
  AriesReviewItem,
  AriesScheduleItem,
} from '@/lib/api/aries-v1';

function formatUtcTimestampLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

export function ShellPanel(props: {
  title?: string;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section
      className={clsx(
        'rounded-[2rem] border border-white/10 bg-white/[0.065] shadow-[0_24px_80px_rgba(0,0,0,0.22)] backdrop-blur-xl',
        props.className,
      )}
    >
      {(props.title || props.eyebrow || props.action) ? (
        <header className="flex items-start justify-between gap-4 border-b border-white/8 px-6 py-5 md:px-7">
          <div className="space-y-1">
            {props.eyebrow ? (
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">
                {props.eyebrow}
              </p>
            ) : null}
            {props.title ? <h2 className="text-lg font-semibold text-white">{props.title}</h2> : null}
          </div>
          {props.action}
        </header>
      ) : null}
      <div className="px-6 py-5 md:px-7">{props.children}</div>
    </section>
  );
}

export interface DashboardHeroMetric {
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'good' | 'watch';
}

export function DashboardHero(props: {
  eyebrow: string;
  title: string;
  description: string;
  metrics: DashboardHeroMetric[];
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={clsx(
        'overflow-hidden rounded-[2.75rem] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.14),transparent_32%),radial-gradient(circle_at_88%_16%,rgba(124,58,237,0.18),transparent_20%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] shadow-[0_36px_120px_rgba(0,0,0,0.28)]',
        props.className,
      )}
    >
      <div className="grid gap-6 px-6 py-6 md:px-8 md:py-8 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">
              {props.eyebrow}
            </p>
            <h2 className="text-4xl font-semibold tracking-[-0.04em] text-white md:text-5xl">
              {props.title}
            </h2>
            <p className="max-w-3xl text-base leading-7 text-white/65">{props.description}</p>
          </div>

          {props.metrics.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {props.metrics.map((metric) => (
                <MetricCard key={metric.label} {...metric} />
              ))}
            </div>
          ) : null}
        </div>

        {props.aside ? (
          <div className="rounded-[2rem] border border-white/10 bg-black/28 p-5 backdrop-blur-sm">
            {props.aside}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function MetricCard(props: DashboardHeroMetric) {
  return (
    <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.06] px-5 py-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-3 text-3xl font-semibold text-white">{props.value}</p>
      <p
        className={clsx(
          'mt-2 text-sm',
          props.tone === 'good'
            ? 'text-emerald-200'
            : props.tone === 'watch'
              ? 'text-amber-100'
              : 'text-white/55',
        )}
      >
        {props.detail}
      </p>
    </div>
  );
}

export function StatusChip(props: { status: AriesCampaignStatus | AriesItemStatus; children?: React.ReactNode }) {
  const palette =
    props.status === 'live'
      ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100'
      : props.status === 'scheduled'
        ? 'border-sky-400/25 bg-sky-400/10 text-sky-100'
        : props.status === 'published_to_meta_paused'
          ? 'border-cyan-400/25 bg-cyan-400/10 text-cyan-100'
          : props.status === 'ready_to_publish'
            ? 'border-violet-400/25 bg-violet-400/10 text-violet-100'
            : props.status === 'ready'
              ? 'border-teal-400/25 bg-teal-400/10 text-teal-100'
        : props.status === 'approved'
          ? 'border-indigo-400/25 bg-indigo-400/10 text-indigo-100'
          : props.status === 'rejected'
            ? 'border-rose-400/25 bg-rose-400/10 text-rose-100'
          : props.status === 'in_review'
            ? 'border-amber-400/25 bg-amber-400/10 text-amber-100'
            : props.status === 'changes_requested'
              ? 'border-rose-400/25 bg-rose-400/10 text-rose-100'
              : 'border-white/15 bg-white/7 text-white/75';

  const label =
    props.children ??
    {
      draft: 'Draft',
      in_review: 'In review',
      ready: 'Ready',
      ready_to_publish: 'Ready to publish',
      published_to_meta_paused: 'Published to Meta (Paused)',
      approved: 'Approved',
      rejected: 'Rejected',
      scheduled: 'Scheduled',
      live: 'Live',
      changes_requested: 'Needs changes',
    }[props.status];

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tracking-[0.03em]',
        palette,
      )}
    >
      {label}
    </span>
  );
}

export function ReviewBadge(props: { count: number; href?: string }) {
  const content = (
    <span className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-300/10 px-3.5 py-2 text-sm font-medium text-amber-50 transition hover:bg-amber-300/15">
      <Layers3 className="h-4 w-4" />
      Review Queue
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-white">
        {props.count}
      </span>
    </span>
  );
  return props.href ? <Link href={props.href}>{content}</Link> : content;
}

export function NextActionCard(props: { recommendation: AriesRecommendation; trustMessage: string }) {
  return (
    <ShellPanel eyebrow="Next Action" title={props.recommendation.title}>
      <div className="space-y-5">
        <p className="max-w-xl text-sm leading-7 text-white/70">{props.recommendation.summary}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={props.recommendation.href}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
          >
            {props.recommendation.actionLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <span className="inline-flex items-center gap-2 text-sm text-white/55">
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
            {props.trustMessage}
          </span>
        </div>
      </div>
    </ShellPanel>
  );
}

export function ApprovalCard(props: { reviewItems: AriesReviewItem[] }) {
  if (props.reviewItems.length === 0) {
    return (
      <EmptyStatePanel
        title="You are clear for now"
        description="New review items will appear here when something needs your decision."
      />
    );
  }

  return (
    <ShellPanel
      eyebrow="Needs Approval"
      title={`${props.reviewItems.length} item${props.reviewItems.length === 1 ? '' : 's'} waiting`}
      action={<ReviewBadge count={props.reviewItems.length} href="/review" />}
    >
      <div className="space-y-3">
        {props.reviewItems.slice(0, 3).map((item) => (
          <Link
            key={item.id}
            href={`/review/${item.id}`}
            className="flex items-start justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/25 px-4 py-4 transition hover:border-white/15 hover:bg-white/[0.08]"
          >
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">{item.title}</p>
              <p className="text-sm text-white/55">
                {item.channel} · {item.placement} · {formatUtcTimestampLabel(item.scheduledFor)}
              </p>
            </div>
            <StatusChip status={item.status} />
          </Link>
        ))}
      </div>
    </ShellPanel>
  );
}

export function ScheduleCard(props: { item: AriesScheduleItem | null }) {
  return (
    <ShellPanel eyebrow="Scheduled Next" title={props.item ? props.item.title : 'Nothing scheduled yet'}>
      {props.item ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-sm text-white/70">
            <CalendarClock className="h-4 w-4 text-white/50" />
            <span>{formatUtcTimestampLabel(props.item.scheduledFor)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-white/60">{props.item.channel}</p>
            <StatusChip status={props.item.status} />
          </div>
        </div>
      ) : (
        <EmptyStatePanel
          title="Nothing is scheduled this week"
          description="Approved work can be scheduled when you are ready."
          compact
        />
      )}
    </ShellPanel>
  );
}

export function CampaignSummaryCard(props: { campaign: AriesCampaign }) {
  return (
    <ShellPanel eyebrow="Active Campaign" title={props.campaign.name}>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <p className="text-sm leading-7 text-white/70">{props.campaign.summary}</p>
          <div className="flex flex-wrap gap-3">
            <StatusChip status={props.campaign.status} />
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {props.campaign.dateRange}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <InfoTile label="Stage" value={props.campaign.stageLabel} />
            <InfoTile label="Next scheduled" value={props.campaign.nextScheduled} />
            <InfoTile label="Pending approvals" value={String(props.campaign.pendingApprovals)} />
          </div>
        </div>
        <div className="rounded-[1.5rem] border border-white/8 bg-black/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/35">Trust note</p>
          <p className="mt-3 text-sm leading-7 text-white/75">{props.campaign.trustNote}</p>
          <Link
            href={`/dashboard/campaigns/${props.campaign.id}`}
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-white"
          >
            Open campaign
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </ShellPanel>
  );
}

function InfoTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.06] px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm font-medium text-white/80">{props.value}</p>
    </div>
  );
}

export function CampaignStageRail(props: { campaign: AriesCampaign }) {
  const steps = [
    { key: 'plan', label: 'Plan', active: true, complete: true },
    {
      key: 'creative',
      label: 'Creative',
      active: props.campaign.status === 'in_review' || props.campaign.status === 'changes_requested',
      complete: props.campaign.status !== 'draft',
    },
    {
      key: 'schedule',
      label: 'Schedule',
      active: props.campaign.status === 'approved' || props.campaign.status === 'scheduled',
      complete: props.campaign.status === 'scheduled' || props.campaign.status === 'live',
    },
    { key: 'results', label: 'Results', active: props.campaign.status === 'live', complete: props.campaign.status === 'live' },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {steps.map((step) => (
        <div
          key={step.key}
          className={clsx(
            'flex items-center gap-2 rounded-full border px-4 py-2 text-sm',
            step.active
              ? 'border-white/20 bg-white/[0.08] text-white'
              : step.complete
                ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                : 'border-white/8 bg-transparent text-white/45',
          )}
        >
          {step.complete ? <CheckCircle2 className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

export function AssetGallery(props: { campaign: AriesCampaign }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {props.campaign.creative.assets.map((asset) => (
        <div
          key={asset.id}
          className="overflow-hidden rounded-[1.6rem] border border-white/8 bg-white/[0.05]"
        >
          <div className="relative flex h-44 items-end bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.14),transparent_45%),linear-gradient(180deg,#1a222b_0%,#0f151b_100%)] p-5">
            <div className="max-w-[14rem] space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/40">{asset.channel}</p>
              <h3 className="text-lg font-semibold text-white">{asset.name}</h3>
              <p className="text-sm text-white/60">{asset.summary}</p>
            </div>
            <div className="absolute right-5 top-5">
              <StatusChip status={asset.status} />
            </div>
          </div>
          <div className="border-t border-white/8 px-5 py-4">
            <p className="text-sm text-white/55">{asset.type}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlacementPreview(props: { version: AriesAssetVersion; label: string }) {
  return (
    <div className="rounded-[1.8rem] border border-white/8 bg-[#131a21] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <div className="mt-4 overflow-hidden rounded-[1.4rem] border border-white/8 bg-[linear-gradient(180deg,#f5f1e8_0%,#ece4d5_100%)] p-5 text-[#171717]">
        <div className="space-y-4 rounded-[1.1rem] border border-black/10 bg-white/70 px-4 py-5 shadow-[0_12px_30px_rgba(0,0,0,0.08)]">
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-black/45">Campaign creative</p>
            <h3 className="text-2xl font-semibold leading-tight">{props.version.headline}</h3>
            <p className="text-sm leading-6 text-black/70">{props.version.supportingText}</p>
          </div>
          <div className="inline-flex rounded-full bg-[#11161c] px-4 py-2 text-sm font-semibold text-white">
            {props.version.cta}
          </div>
        </div>
      </div>
    </div>
  );
}

export function VersionCompare(props: {
  currentVersion: AriesAssetVersion;
  previousVersion?: AriesAssetVersion;
}) {
  if (!props.previousVersion) {
    return <PlacementPreview version={props.currentVersion} label={props.currentVersion.label} />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlacementPreview version={props.previousVersion} label={props.previousVersion.label} />
      <PlacementPreview version={props.currentVersion} label={props.currentVersion.label} />
    </div>
  );
}

export function ScheduleComposer(props: { items: AriesScheduleItem[] }) {
  return (
    <div className="space-y-3">
      {props.items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-[1.25rem] border border-white/8 bg-black/15 px-4 py-4"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium text-white">{item.title}</p>
            <p className="text-sm text-white/55">
              {item.channel} · {formatUtcTimestampLabel(item.scheduledFor)}
            </p>
          </div>
          <StatusChip status={item.status} />
        </div>
      ))}
    </div>
  );
}

export function PublishReceipt() {
  return (
    <div className="rounded-[1.4rem] border border-emerald-400/15 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-50">
      Aries will keep approved work paused until the scheduled publish window arrives. You can still reschedule or pause it before it goes live.
    </div>
  );
}

export function KpiStrip(props: { items: AriesKpi[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {props.items.map((item) => (
        <MetricCard
          key={item.label}
          label={item.label}
          value={item.value}
          detail={item.delta}
          tone={item.tone === 'neutral' ? 'default' : item.tone}
        />
      ))}
    </div>
  );
}

export function RecommendationCard(props: { recommendation: AriesRecommendation }) {
  return (
    <div className="rounded-[1.5rem] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02))] p-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 rounded-full bg-white/10 p-2">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-white">{props.recommendation.title}</p>
          <p className="text-sm leading-6 text-white/60">{props.recommendation.summary}</p>
          <Link href={props.recommendation.href} className="inline-flex items-center gap-2 text-sm font-medium text-white">
            {props.recommendation.actionLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

export function EmptyStatePanel(props: {
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-[1.5rem] border border-dashed border-white/10 bg-black/10 text-center',
        props.compact ? 'px-5 py-6' : 'px-6 py-9',
      )}
    >
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/7">
        <AlertCircle className="h-5 w-5 text-white/45" />
      </div>
      <h3 className="text-base font-semibold text-white">{props.title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-7 text-white/55">{props.description}</p>
      {props.action ? <div className="mt-5">{props.action}</div> : null}
    </div>
  );
}

export function LoadingStateGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="h-36 animate-pulse rounded-[1.4rem] border border-white/8 bg-white/[0.055]"
        />
      ))}
    </div>
  );
}

export function ChannelHealthIndicator(props: { channel: AriesChannelConnection }) {
  const tone =
    props.channel.health === 'connected'
      ? 'bg-emerald-400'
      : props.channel.health === 'attention'
        ? 'bg-amber-300'
        : 'bg-white/25';

  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-white">{props.channel.name}</p>
          <p className="text-sm text-white/45">{props.channel.handle}</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1.5 text-xs text-white/70">
          <span className={clsx('h-2.5 w-2.5 rounded-full', tone)} />
          {props.channel.health === 'connected'
            ? 'Healthy'
            : props.channel.health === 'attention'
              ? 'Needs attention'
              : 'Not connected'}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-white/55">{props.channel.detail}</p>
    </div>
  );
}

export function TrustRibbon() {
  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm text-white/70">
      <ShieldCheck className="h-4 w-4 text-emerald-300" />
      Nothing goes live without approval.
    </div>
  );
}

export function SectionLink(props: { href: string; label: string }) {
  return (
    <Link
      href={props.href}
      className="inline-flex items-center gap-2 text-sm font-medium text-white/80 transition hover:text-white"
    >
      {props.label}
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}

export function SurfaceField(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2.5">
      <div className="space-y-1">
        <span className="text-sm font-medium text-white/78">{props.label}</span>
        {props.hint ? <p className="text-xs leading-5 text-white/45">{props.hint}</p> : null}
      </div>
      {props.children}
    </label>
  );
}

export function SurfaceInput(props: ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      {...props}
      className={clsx(
        'w-full rounded-[1.1rem] border border-white/10 bg-black/20 px-4 py-3 text-white placeholder:text-white/28 focus:border-white/20 focus:outline-none',
        props.className,
      )}
    />
  );
}

export function SurfaceSelect(props: ComponentPropsWithoutRef<'select'>) {
  return (
    <select
      {...props}
      className={clsx(
        'w-full rounded-[1.1rem] border border-white/10 bg-black/20 px-4 py-3 text-white focus:border-white/20 focus:outline-none',
        props.className,
      )}
    />
  );
}

export function ActivityFeed(props: {
  items: Array<{ id: string; label: string; detail: string; at: string }>;
}) {
  return (
    <div className="space-y-3">
      {props.items.map((item) => (
        <div key={item.id} className="flex gap-3 rounded-[1.2rem] border border-white/8 bg-black/12 px-4 py-4">
          <div className="mt-0.5 rounded-full bg-white/10 p-2">
            <Zap className="h-4 w-4 text-white/70" />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-white">{item.label}</p>
              <span className="text-xs text-white/35">{item.at}</span>
            </div>
            <p className="text-sm leading-6 text-white/55">{item.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
