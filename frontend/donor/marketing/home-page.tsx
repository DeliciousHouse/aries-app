import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  Clock3,
  Compass,
  Facebook,
  Instagram,
  Layers3,
  Lightbulb,
  Linkedin,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Twitter,
  Youtube,
  Zap,
} from 'lucide-react';

import { cn } from '../lib/utils';
import { DonorMarketingShell } from './chrome';
import { HeroOrbit } from './hero-orbit';

const PROBLEMS = [
  {
    icon: Clock3,
    title: 'Slow campaign execution',
    description: 'Manual planning, coordination, and review cycles stretch launch windows and make fast iteration impossible.',
  },
  {
    icon: Layers3,
    title: 'Disconnected tools',
    description: 'Marketers bounce between research docs, calendars, copy tools, and publishing dashboards without a shared control plane.',
  },
  {
    icon: Search,
    title: 'Low signal on what matters',
    description: 'Teams chase channels and trends without a consistent stream of market intelligence, audience insight, and performance context.',
  },
  {
    icon: ShieldCheck,
    title: 'Risky browser workflows',
    description: 'OAuth, approvals, and publishing should stay behind a trusted runtime boundary instead of leaking sensitive implementation details.',
  },
] as const;

const FEATURES = [
  {
    icon: Sparkles,
    title: 'AI-native strategy engine',
    description: 'Turn brand inputs, competitor signals, and channel context into actionable campaign direction without extra coordination overhead.',
  },
  {
    icon: Search,
    title: 'Market intelligence',
    description: 'Continuously gather competitive inputs, audience shifts, and channel-specific context to keep campaigns moving in the right direction.',
  },
  {
    icon: Zap,
    title: 'Execution-ready orchestration',
    description: 'Launch work through Aries while keeping OpenClaw and Lobster behind a clean server boundary.',
  },
  {
    icon: CalendarDays,
    title: 'Publishing calendar visibility',
    description: 'Coordinate timing, channel readiness, and approval checkpoints from one polished interface.',
  },
  {
    icon: BarChart3,
    title: 'Performance telemetry',
    description: 'Track campaign health, throughput, and platform status with a premium overview tuned for operators, not spreadsheets.',
  },
  {
    icon: Compass,
    title: 'Cross-platform delivery',
    description: 'Keep platform-by-platform behavior legible while preserving one central source of truth for campaign execution.',
  },
] as const;

const STEPS = [
  {
    icon: Search,
    title: 'Discover',
    description: 'Pull market context, brand inputs, and channel signals into one runtime-aware starting point.',
  },
  {
    icon: Lightbulb,
    title: 'Plan',
    description: 'Shape strategy, creative direction, and approvals with typed browser-safe workflows.',
  },
  {
    icon: Zap,
    title: 'Execute',
    description: 'Send campaign work through Aries while OpenClaw and Lobster stay server-side.',
  },
  {
    icon: BarChart3,
    title: 'Refine',
    description: 'Review status, publishing outcomes, and next actions without leaving the operator surface.',
  },
] as const;

const TRUSTED_LABELS = ['NEXUS', 'VELOCITY', 'QUANTUM', 'ELEVATE', 'ORBIT'] as const;

const CHANNELS = [
  { label: 'X', icon: Twitter },
  { label: 'LinkedIn', icon: Linkedin },
  { label: 'Instagram', icon: Instagram },
  { label: 'Facebook', icon: Facebook },
  { label: 'YouTube', icon: Youtube },
] as const;

const SCHEDULE = [
  {
    day: 'Mon',
    date: '16',
    posts: [
      { title: 'AI marketing signals brief', platform: 'LinkedIn', status: 'Published', border: 'border-blue-500/40' },
      { title: 'Aries launch teaser', platform: 'X', status: 'Published', border: 'border-sky-400/40' },
    ],
  },
  {
    day: 'Tue',
    date: '17',
    posts: [
      { title: 'Audience insight reel', platform: 'Instagram', status: 'Published', border: 'border-pink-500/40' },
      { title: 'Operator walkthrough', platform: 'YouTube', status: 'Published', border: 'border-red-500/40' },
    ],
  },
  {
    day: 'Wed',
    date: '18',
    posts: [
      { title: 'Competitive angle memo', platform: 'LinkedIn', status: 'Published', border: 'border-blue-500/40' },
      { title: 'Campaign timing note', platform: 'Facebook', status: 'Published', border: 'border-indigo-500/40' },
    ],
  },
  {
    day: 'Thu',
    date: '19',
    posts: [
      { title: 'Search-aware landing page', platform: 'X', status: 'Published', border: 'border-sky-400/40' },
      { title: 'Weekly recap story set', platform: 'Instagram', status: 'Published', border: 'border-pink-500/40' },
    ],
  },
  {
    day: 'Fri',
    date: '20',
    posts: [
      { title: 'Aries operator launch', platform: 'LinkedIn', status: 'Scheduled', border: 'border-primary/40' },
    ],
  },
] as const;

const PLANS = [
  {
    name: 'Starter',
    price: '$49',
    description: 'For lean teams that need a premium campaign runtime without excess complexity.',
    cta: '/login',
    ctaLabel: 'Get started',
    highlight: false,
    features: ['3 social accounts', 'Campaign planning workspace', 'Weekly reporting', 'Approval checkpoints'],
  },
  {
    name: 'Growth',
    price: '$149',
    description: 'For scaling teams that want more channels, better telemetry, and faster execution.',
    cta: '/login',
    ctaLabel: 'Launch the console',
    highlight: true,
    features: ['Unlimited channels', 'Advanced job monitoring', 'Priority runtime support', 'Daily optimization reviews'],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    description: 'For larger organizations operating regulated approvals, multiple brands, or bespoke workflows.',
    cta: '/contact',
    ctaLabel: 'Talk to us',
    highlight: false,
    features: ['Custom rollout support', 'Approval policy design', 'API access', 'Dedicated onboarding'],
  },
] as const;

function Hero() {
  return (
    <section className="relative overflow-hidden pb-18 pt-32 sm:pt-36 lg:pb-24 lg:pt-40">
      <div className="bg-animate absolute inset-0 opacity-90" />
      <div className="pointer-events-none absolute left-[8%] top-28 h-52 w-52 rounded-full bg-primary/16 blur-[110px]" />
      <div className="pointer-events-none absolute bottom-10 right-[10%] h-60 w-60 rounded-full bg-secondary/14 blur-[120px]" />
      <HeroOrbit />

      <div className="container relative z-10 mx-auto px-6">
        <div className="max-w-3xl lg:max-w-[42rem]">
            <span className="eyebrow mb-6">
              <Sparkles className="h-4 w-4 text-primary" />
              Next-generation marketing intelligence
            </span>

            <h1 className="public-heading-xl mb-6 max-w-4xl text-balance text-white">
              Turn Your Marketing Into an <span className="text-gradient">Autonomous Growth Engine</span>
            </h1>

            <p className="public-subcopy mb-8">
              Aries brings together market intelligence, campaign planning, approvals, and publishing
              orchestration in a polished operator experience built around Lobster, OpenClaw, and
              internal runtime services only.
            </p>

            <div className="flex flex-col gap-4 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex min-h-13 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-7 py-3.5 text-base font-semibold text-white shadow-xl shadow-primary/20 transition-transform duration-200 hover:translate-y-[-1px]"
              >
                Start automating <ArrowRight className="h-5 w-5" />
              </Link>
              <Link
                href="/documentation"
                className="inline-flex min-h-13 items-center justify-center gap-2 rounded-full border border-white/12 bg-white/6 px-7 py-3.5 text-base font-semibold text-white/88 transition-colors hover:bg-white/10"
              >
                <Play className="h-5 w-5 fill-current" />
                See runtime
              </Link>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              {[
                { label: 'Channels watched', value: '7', note: 'One operator surface' },
                { label: 'Approval states', value: '4', note: 'Visible end-to-end' },
                { label: 'Runtime latency', value: '<1s', note: 'Fast app shell' },
              ].map((stat) => (
                <div key={stat.label} className="glass rounded-[1.5rem] p-5">
                  <p className="text-sm uppercase tracking-[0.18em] text-white/48">{stat.label}</p>
                  <p className="mt-3 text-3xl font-semibold text-white">{stat.value}</p>
                  <p className="mt-2 text-sm text-white/64">{stat.note}</p>
                </div>
              ))}
            </div>
        </div>
      </div>
    </section>
  );
}

function TrustBand() {
  return (
    <section className="border-y border-white/6 bg-black/55 py-10">
      <div className="container mx-auto px-6">
        <p className="mb-7 text-center text-sm font-semibold uppercase tracking-[0.24em] text-white/52">
          Trusted by industry leaders
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5 text-xl font-semibold tracking-[0.16em] text-white/58 md:gap-x-18">
          {TRUSTED_LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section id="product" className="public-section">
      <div className="container mx-auto px-6">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <span className="eyebrow mb-6">Operator pain points</span>
          <h2 className="public-heading-lg mb-5">
            Marketing today is still <span className="text-gradient">fragmented by default</span>
          </h2>
          <p className="mx-auto max-w-2xl text-base leading-7 text-white/70 md:text-lg">
            Aries is designed to reduce coordination drag, not add another decorative dashboard.
            The public experience should communicate that clearly while staying fast and stable.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {PROBLEMS.map(({ icon: Icon, title, description }) => (
            <article key={title} className="glass rounded-[1.8rem] p-6 md:p-7">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/7">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="mb-3 font-display text-2xl font-semibold text-white">{title}</h3>
              <p className="text-sm leading-7 text-white/68">{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CapabilityStrip() {
  return (
    <section className="public-section pt-0">
      <div className="container mx-auto px-6">
        <div className="glass rounded-[2rem] px-6 py-7 md:px-10 md:py-9">
          <div className="mx-auto max-w-4xl text-center">
            <h2 className="public-heading-lg mb-6">Meet Aries AI</h2>
            <p className="mx-auto max-w-3xl text-base leading-8 text-white/70 md:text-lg">
              An AI-native marketing intelligence surface that keeps strategy, approvals, and
              publishing orchestration legible to operators while the real execution boundary stays server-side.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 md:gap-4">
            {['Market intelligence', 'Strategy', 'Content', 'Automation', 'Optimization'].map((step, index, array) => (
              <div key={step} className="contents">
                <span className="hover-gradient-border rounded-full border border-primary/20 bg-white/5 px-5 py-3 text-sm font-semibold text-white/84">
                  {step}
                </span>
                {index < array.length - 1 ? <span className="hidden h-px w-8 bg-white/14 md:block" /> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="public-section">
      <div className="container mx-auto px-6">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <span className="eyebrow mb-6">Feature overview</span>
          <h2 className="public-heading-lg mb-5">
            Everything needed for a <span className="text-gradient">premium marketing control plane</span>
          </h2>
          <p className="mx-auto max-w-2xl text-base leading-7 text-white/70 md:text-lg">
            The product story stays polished, but the implementation now leans toward stable rendering,
            lower mobile paint cost, and cleaner semantics.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <article key={title} className="glass rounded-[1.9rem] p-6 md:p-7">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/7">
                <Icon className="h-5 w-5 text-white" />
              </div>
              <h3 className="mb-3 font-display text-2xl font-semibold text-white">{title}</h3>
              <p className="text-sm leading-7 text-white/68">{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="public-section">
      <div className="container mx-auto px-6">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <span className="eyebrow mb-6">How it works</span>
          <h2 className="public-heading-lg mb-5">Four steps to autonomous growth</h2>
          <p className="mx-auto max-w-2xl text-base leading-7 text-white/70 md:text-lg">
            A tighter, lighter homepage should still explain the operating model without relying on
            scroll choreography or animation-heavy storytelling.
          </p>
        </div>

        <div className="relative grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className="absolute left-0 right-0 top-12 hidden h-px bg-gradient-to-r from-primary/20 via-secondary/20 to-primary/20 xl:block" />
          {STEPS.map(({ icon: Icon, title, description }, index) => (
            <article key={title} className="glass relative rounded-[1.9rem] p-6 text-center md:p-7">
              <div className="mx-auto mb-6 flex h-18 w-18 items-center justify-center rounded-[1.5rem] border border-white/10 bg-white/6">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <span className="absolute right-5 top-5 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-white/56">
                0{index + 1}
              </span>
              <h3 className="mb-3 font-display text-2xl font-semibold text-white">{title}</h3>
              <p className="text-sm leading-7 text-white/68">{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ContentCalendar() {
  return (
    <section id="calendar" className="public-section overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <span className="eyebrow mb-6">Operator preview</span>
          <h2 className="public-heading-lg mb-5">
            Autonomous <span className="text-gradient">content calendar</span>
          </h2>
          <p className="mx-auto max-w-2xl text-base leading-7 text-white/70 md:text-lg">
            A lighter static preview still shows the product clearly while avoiding extra client JavaScript on the homepage.
          </p>
        </div>

        <div className="glass overflow-hidden rounded-[2.2rem]">
          <div className="grid lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="border-b border-white/10 bg-white/5 p-6 lg:border-b-0 lg:border-r lg:p-7">
              <div className="mb-6 flex items-center justify-between">
                <p className="font-display text-2xl font-semibold text-white">Calendar</p>
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-black/25 text-white/56"
                >
                  +
                </span>
              </div>

              <div className="mb-7 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/52">
                Search posts…
              </div>

              <div className="space-y-7">
                <div>
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-white/48">Platforms</p>
                  <div className="space-y-2">
                    {CHANNELS.map(({ label }) => (
                      <div key={label} className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm text-white/74">
                        <span>{label}</span>
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-white/48">Status</p>
                  <div className="space-y-3 text-sm text-white/68">
                    <div className="flex items-center gap-3">
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                      Published
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                      Scheduled
                    </div>
                  </div>
                </div>
              </div>
            </aside>

            <div className="flex min-w-0 flex-col">
              <div className="flex flex-col gap-5 border-b border-white/10 p-6 md:flex-row md:items-center md:justify-between md:p-7">
                <div className="flex flex-wrap items-center gap-4">
                  <p className="font-display text-2xl font-semibold text-white">March 2026</p>
                  <div className="flex items-center gap-2 text-sm text-white/66" aria-hidden="true">
                    <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">←</span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">Today</span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">→</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1 text-sm font-semibold text-white/74" aria-hidden="true">
                    <span className="rounded-lg bg-primary/15 px-4 py-2 text-primary">Week</span>
                    <span className="rounded-lg px-4 py-2">Month</span>
                  </div>
                  <Link
                    href="/calendar"
                    className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-primary to-secondary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/20"
                  >
                    Open runtime
                  </Link>
                </div>
              </div>

              <div className="overflow-x-auto p-6 md:p-7">
                <div className="grid min-w-[760px] grid-cols-5 gap-4">
                  {SCHEDULE.map((day) => (
                    <div key={day.day} className="space-y-4">
                      <div className="text-center">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/44">{day.day}</p>
                        <p className={cn(
                          'mx-auto flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold',
                          day.date === '20' ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-white/5 text-white/72',
                        )}>
                          {day.date}
                        </p>
                      </div>

                      <div className="space-y-3">
                        {day.posts.map((post) => (
                          <article key={`${day.day}-${post.title}`} className={cn('rounded-[1rem] border bg-white/5 p-3', post.border)}>
                            <div className="mb-2 flex items-center justify-between gap-2 text-[0.68rem] uppercase tracking-[0.18em] text-white/44">
                              <span>{post.platform}</span>
                              <span>{post.status}</span>
                            </div>
                            <p className="text-sm font-medium leading-6 text-white/84">{post.title}</p>
                          </article>
                        ))}
                        <div className="rounded-[1rem] border border-dashed border-white/10 p-3 text-center text-sm text-white/42">
                          Approval slot available
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="public-section">
      <div className="container mx-auto px-6">
        <div className="mx-auto mb-14 max-w-3xl text-center">
          <span className="eyebrow mb-6">Pricing</span>
          <h2 className="public-heading-lg mb-5">Simple, transparent pricing</h2>
          <p className="mx-auto max-w-2xl text-base leading-7 text-white/70 md:text-lg">
            Right-sized tiers for startups, growth teams, and larger operators that need custom runtime support.
          </p>
        </div>

        <div className="mx-auto grid max-w-6xl gap-5 md:grid-cols-3">
          {PLANS.map((plan) => (
            <article key={plan.name} className={cn('relative flex flex-col rounded-[2rem] border p-6 md:p-7', plan.highlight ? 'glass border-primary/45 shadow-[0_24px_80px_rgba(124,58,237,0.18)]' : 'glass border-white/10')}>
              {plan.highlight ? (
                <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
                  Most popular
                </span>
              ) : null}

              <div className="mb-7">
                <h3 className="font-display text-2xl font-semibold text-white">{plan.name}</h3>
                <p className="mt-4 text-4xl font-semibold text-white">{plan.price}</p>
                <p className="mt-4 text-sm leading-7 text-white/68">{plan.description}</p>
              </div>

              <ul className="mb-8 flex-1 space-y-3 text-sm text-white/76">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-3">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-primary" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.cta}
                className={cn(
                  'inline-flex min-h-12 items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold transition-colors',
                  plan.highlight
                    ? 'bg-gradient-to-r from-primary to-secondary text-white shadow-lg shadow-primary/20'
                    : 'border border-white/10 bg-white/8 text-white hover:bg-white/12',
                )}
              >
                {plan.ctaLabel}
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="public-section pt-0">
      <div className="container mx-auto px-6">
        <div className="glass relative overflow-hidden rounded-[2.5rem] px-6 py-12 text-center md:px-12 md:py-16">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(124,58,237,0.26),transparent_35%),radial-gradient(circle_at_82%_25%,rgba(168,85,247,0.22),transparent_28%),radial-gradient(circle_at_50%_85%,rgba(255,255,255,0.08),transparent_42%)]" />
          <div className="relative z-10 mx-auto max-w-3xl">
            <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Sparkles className="h-7 w-7 text-primary" />
            </div>
            <h2 className="public-heading-lg mb-5">
              Bring the <span className="text-gradient">premium operator experience</span> to your runtime
            </h2>
            <p className="mx-auto mb-8 max-w-2xl text-base leading-8 text-white/72 md:text-lg">
              Launch the canonical Aries experience against your existing runtime without leaking implementation details to the browser.
            </p>
            <div className="flex flex-col justify-center gap-4 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex min-h-13 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-7 py-3.5 text-base font-semibold text-white shadow-xl shadow-primary/20"
              >
                Open the console <ArrowRight className="h-5 w-5" />
              </Link>
              <Link
                href="/documentation"
                className="inline-flex min-h-13 items-center justify-center rounded-full border border-white/12 bg-white/6 px-7 py-3.5 text-base font-semibold text-white/86"
              >
                Review runtime docs
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function DonorHomePage() {
  return (
    <DonorMarketingShell heroMode>
      <Hero />
      <TrustBand />
      <Problem />
      <CapabilityStrip />
      <Features />
      <HowItWorks />
      <ContentCalendar />
      <Pricing />
      <FinalCTA />
    </DonorMarketingShell>
  );
}
