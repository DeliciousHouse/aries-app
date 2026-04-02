import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Check,
  Clock,
  Layers,
  Lightbulb,
  type LucideIcon,
  PenTool,
  Play,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  TrendingDown,
  Zap,
} from 'lucide-react';

import { cn } from '../lib/utils';
import { AriesMark } from '../ui';
import { DonorMarketingShell } from './chrome';
import MarketingDashboardPreview from './marketing-dashboard-preview';

type IconCard = {
  icon: LucideIcon;
  title: string;
  description: string;
};

type MetricCard = {
  label: string;
  value: string;
  detail: string;
};

const TRUSTED_LABELS = ['NEXUS', 'VELOCITY', 'QUANTUM', 'ELEVATE', 'ORBIT'] as const;

const HERO_PROOF: MetricCard[] = [
  {
    label: 'Approvals waiting',
    value: '3',
    detail: 'Review queue stays visible before launch.',
  },
  {
    label: 'Next launch',
    value: 'Thu 8:30',
    detail: 'The schedule stays readable without digging.',
  },
  {
    label: 'Next step',
    value: '1 clear action',
    detail: 'Results end with what to do now.',
  },
];

const PROBLEMS: IconCard[] = [
  {
    icon: TrendingDown,
    title: 'Missed launches',
    description: 'Without a clear schedule, campaigns slip and opportunities pass before you notice.',
  },
  {
    icon: AlertCircle,
    title: 'Unclear approvals',
    description: 'When nobody knows who approved what, mistakes go live and trust erodes fast.',
  },
  {
    icon: Clock,
    title: 'Scattered results',
    description: 'Checking five different dashboards to answer one question: is this working?',
  },
  {
    icon: Layers,
    title: 'No clear next step',
    description: 'Finishing a campaign and having no idea what to do next to keep momentum going.',
  },
];

const FEATURES: IconCard[] = [
  {
    icon: Share2,
    title: 'Campaign planning',
    description: 'Turn your business goals into a clear campaign plan you can read in seconds.',
  },
  {
    icon: Search,
    title: 'Creative review',
    description: 'See every draft, compare versions, and approve what ships before it goes live.',
  },
  {
    icon: PenTool,
    title: 'Approval safety',
    description: 'Nothing publishes without sign-off. Material edits return to review automatically.',
  },
  {
    icon: Zap,
    title: 'Launch scheduling',
    description: 'See exactly what is going out, when, and on which channels before it runs.',
  },
  {
    icon: BarChart3,
    title: 'Results clarity',
    description: 'Business-readable reporting that answers one question: is this working?',
  },
  {
    icon: RefreshCw,
    title: 'Next-step recommendations',
    description: 'Every result ends with a clear next action so you always know what to do.',
  },
];

const HOW_IT_WORKS: IconCard[] = [
  {
    icon: Search,
    title: 'Connect your business',
    description: 'Set up once with your website, brand, and goals. Aries handles the rest.',
  },
  {
    icon: Lightbulb,
    title: 'Review the plan',
    description: 'See a clear campaign plan in plain English before anything is created.',
  },
  {
    icon: Zap,
    title: 'Approve and launch',
    description: 'Review every creative draft, approve what ships, and schedule with confidence.',
  },
  {
    icon: BarChart3,
    title: 'See what worked',
    description: 'Business-readable results with one clear recommendation for what to do next.',
  },
];

const SCHEDULE_DAYS = [
  {
    day: 'Mon',
    date: '16',
    posts: [
      { title: 'AI Marketing Trends 2026 Strategy', time: '09:00', status: 'Published' },
      { title: 'Feature Reveal', time: '14:00', status: 'Published' },
    ],
  },
  {
    day: 'Tue',
    date: '17',
    posts: [
      { title: 'GEO Optimization Guide', time: '10:30', status: 'Published' },
      { title: 'Market Intelligence 101', time: '16:00', status: 'Published' },
    ],
  },
  {
    day: 'Wed',
    date: '18',
    posts: [
      { title: 'Spring Campaign Case Study', time: '11:00', status: 'Review' },
      { title: 'Facebook Ads Mastery', time: '15:30', status: 'Review' },
    ],
  },
  {
    day: 'Thu',
    date: '19',
    posts: [
      { title: 'Why AEO is the new SEO', time: '09:30', status: 'Scheduled' },
      { title: 'Weekly AI Wrap-up', time: '15:00', status: 'Scheduled' },
    ],
  },
  {
    day: 'Fri',
    date: '20',
    posts: [{ title: 'Quarterly Growth Planning', time: '10:00', status: 'Scheduled' }],
  },
] as const;

const RESULT_METRICS: MetricCard[] = [
  {
    label: 'Active campaigns',
    value: '12',
    detail: 'A single view of what is live, scheduled, or waiting for approval.',
  },
  {
    label: 'Approval rate',
    value: '96%',
    detail: 'Owners can spot edits before launch instead of fixing them after launch.',
  },
  {
    label: 'Reporting summary',
    value: '1 answer',
    detail: 'Every campaign closes with a plain-language summary and a next recommendation.',
  },
];

const SAFETY_POINTS = [
  'Nothing publishes without sign-off.',
  'Material edits return to review automatically.',
  'The owner always sees what is queued, scheduled, and live.',
] as const;

const PLANS = [
  {
    name: 'Starter',
    price: '$49',
    description: 'For one business with a few active channels.',
    features: ['3 Connected Channels', 'Campaign Planning', 'Approval Queue', 'Weekly Results'],
    highlight: false,
  },
  {
    name: 'Growth',
    price: '$149',
    description: 'For businesses ready to run consistent campaigns.',
    features: ['Unlimited Channels', 'Full Campaign Workspace', 'Detailed Results', 'Next-Step Recommendations', 'Priority Support'],
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    description: 'For multi-location or high-volume businesses.',
    features: ['Multiple Brands', 'Dedicated Support', 'Custom Reporting', 'Team Approvals', 'SLA Guarantee'],
    highlight: false,
  },
] as const;

function SectionShell({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn('deferred-section py-24', className)}>
      <div className="container mx-auto px-6">{children}</div>
    </section>
  );
}

function SectionIntro({
  title,
  description,
  align = 'center',
}: {
  title: ReactNode;
  description: ReactNode;
  align?: 'center' | 'left';
}) {
  return (
    <div className={cn('mb-16 max-w-3xl', align === 'center' ? 'mx-auto text-center' : 'text-left')}>
      <h2 className="text-4xl font-bold leading-tight md:text-[3rem]">{title}</h2>
      <p className="mt-5 text-base leading-7 text-white/60 md:text-lg">{description}</p>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden pb-20 pt-16 md:pb-24 md:pt-20">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]">
        <div className="absolute left-[-8rem] top-10 h-72 w-72 rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute right-[-6rem] top-24 h-80 w-80 rounded-full bg-secondary/14 blur-[140px]" />
      </div>

      <div className="container relative mx-auto grid items-center gap-16 px-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm font-medium text-white/80 shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Nothing goes live without your approval</span>
          </div>

          <h1 className="mt-8 text-4xl font-bold leading-[1.02] tracking-tight md:text-[4.2rem]">
            Plan, create, approve, launch, and{' '}
            <span className="text-gradient">improve your marketing</span>
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-8 text-white/65 md:text-lg">
            Aries gives business owners a calm workspace to see what is running, what needs approval, what is scheduled next, what is working, and what to do now.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Link
              href="/onboarding/start"
              className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-8 text-base font-semibold text-white shadow-xl shadow-primary/20 transition-opacity hover:opacity-90"
            >
              Start with your business <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex min-h-14 items-center justify-center rounded-full border border-white/12 bg-white/5 px-8 text-base font-semibold text-white transition-colors hover:bg-white/10"
            >
              Log in
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full border border-white/12 bg-white/5 px-8 text-base font-semibold text-white transition-colors hover:bg-white/10"
            >
              <Play className="h-5 w-5 fill-current" /> See how it works
            </Link>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {HERO_PROOF.map((item) => (
              <div key={item.label} className="glass-panel rounded-[1.75rem] p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">{item.label}</p>
                <p className="mt-3 text-xl font-bold text-white">{item.value}</p>
                <p className="mt-2 text-sm leading-6 text-white/55">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative lg:justify-self-end">
          <div className="glass rounded-[2rem] border-white/10 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
              <div className="flex items-center gap-3">
                <AriesMark sizeClassName="h-12 w-12" sizes="48px" />
                <div>
                  <p className="text-sm font-semibold text-white">Aries workspace</p>
                  <p className="text-sm text-white/45">A calm view of plan, review, launch, and results.</p>
                </div>
              </div>
              <div className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                Approval-safe
              </div>
            </div>

            <div className="mt-6 grid gap-4">
              <MarketingDashboardPreview />

              <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Spring campaign</p>
                    <p className="mt-1 text-sm text-white/50">Plan approved. Creative review opens next.</p>
                  </div>
                  <span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">Plan</span>
                </div>
                <div className="mt-4 h-2 rounded-full bg-white/8">
                  <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-primary to-secondary" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Review queue</p>
                  <p className="mt-3 text-3xl font-bold">3</p>
                  <p className="mt-2 text-sm text-white/55">Items waiting for owner approval.</p>
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Next launch</p>
                  <p className="mt-3 text-3xl font-bold">Thu</p>
                  <p className="mt-2 text-sm text-white/55">8:30 AM across approved channels.</p>
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-white/10 bg-black/35 p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">What to do now</p>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-xs font-semibold text-white/60">Results</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/60">
                  Keep the strongest performing offer, shorten the next caption, and launch the next approved creative on Friday morning.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustedBy() {
  return (
    <section className="border-y border-white/5 bg-black/50 py-12">
      <div className="container mx-auto px-6">
        <p className="mb-8 text-center text-sm font-medium uppercase tracking-[0.3em] text-white/30">
          Trusted by industry leaders
        </p>
        <div className="flex flex-wrap items-center justify-center gap-10 text-xl font-bold tracking-[0.3em] text-white/35 md:gap-20 md:text-2xl">
          {TRUSTED_LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function MeetAries() {
  const stages = [
    'Set up your business',
    'See the plan',
    'Review the creative',
    'Launch safely',
    'See what worked',
  ] as const;

  return (
    <SectionShell>
      <SectionIntro
        title="Meet Aries"
        description="A calm workspace where you plan campaigns, approve creative, launch safely, and see what worked without learning marketing software."
      />

      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-3">
        {stages.map((stage) => (
          <div
            key={stage}
            className="rounded-full border border-primary/20 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white/80"
          >
            {stage}
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function Problem() {
  return (
    <SectionShell>
      <SectionIntro
        title={
          <>
            Marketing without a system is <span className="text-red-400">stressful</span>
          </>
        }
        description="Small businesses deserve a calm, clear place to plan marketing, approve work, and see what is actually driving results."
      />

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {PROBLEMS.map((problem) => {
          const Icon = problem.icon;
          return (
            <article key={problem.title} className="glass rounded-[2rem] p-7">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                <Icon className="h-6 w-6 text-white" />
              </div>
              <h3 className="text-xl font-bold text-white">{problem.title}</h3>
              <p className="mt-4 text-sm leading-7 text-white/55">{problem.description}</p>
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function Features() {
  return (
    <SectionShell>
      <SectionIntro
        title={
          <>
            Everything you need to <span className="text-gradient">market with confidence</span>
          </>
        }
        description="The homepage now shows the operating model directly: clear planning, readable approval, a visible schedule, and results that end with a next move."
      />

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <article key={feature.title} className="glass rounded-[2rem] p-7">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                <Icon className="h-6 w-6 text-white" />
              </div>
              <h3 className="text-2xl font-bold text-white">{feature.title}</h3>
              <p className="mt-4 text-sm leading-7 text-white/55">{feature.description}</p>
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function HowItWorks() {
  return (
    <SectionShell id="how-it-works">
      <SectionIntro title="How It Works" description="Four steps to marketing clarity." />

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {HOW_IT_WORKS.map((step, index) => {
          const Icon = step.icon;
          return (
            <article key={step.title} className="glass rounded-[2rem] p-7 text-left">
              <div className="mb-5 flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                  <Icon className="h-6 w-6 text-white" />
                </div>
                <span className="text-sm font-semibold text-white/35">0{index + 1}</span>
              </div>
              <h3 className="text-xl font-bold text-white">{step.title}</h3>
              <p className="mt-4 text-sm leading-7 text-white/55">{step.description}</p>
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function SafetyAndSchedule() {
  return (
    <SectionShell id="safety">
      <div className="grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <SectionIntro
            align="left"
            title="Approval safety without a black box"
            description="The homepage no longer depends on sticky scroll theater to explain the product. The story is visible immediately in plain markup."
          />

          <div className="grid gap-4">
            {SAFETY_POINTS.map((point) => (
              <div key={point} className="glass-panel rounded-[1.5rem] p-5">
                <div className="flex items-start gap-4">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-primary/15">
                    <Check className="h-4 w-4 text-primary" />
                  </div>
                  <p className="text-sm leading-7 text-white/70">{point}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
            <p className="text-sm font-semibold text-white">Primary proof</p>
            <p className="mt-3 text-sm leading-7 text-white/60">
              The owner can read the plan, the review queue, the schedule, and the recommendation without waiting for client-side motion, orbit graphics, or a 3D embed to load.
            </p>
          </div>
        </div>

        <div className="glass rounded-[2rem] p-6">
          <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Your marketing schedule</p>
              <p className="mt-1 text-sm text-white/50">See what is planned, approved, and scheduled across the week.</p>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/70">
              March 2026
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-5">
            {SCHEDULE_DAYS.map((day) => (
              <div key={day.day} className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-4">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">{day.day}</p>
                    <p className="mt-1 text-lg font-bold text-white">{day.date}</p>
                  </div>
                  <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                </div>

                <div className="space-y-3">
                  {day.posts.map((post) => (
                    <div key={post.title} className="rounded-2xl border border-white/8 bg-black/30 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/30">{post.time}</p>
                      <p className="mt-2 text-sm font-medium leading-6 text-white/80">{post.title}</p>
                      <p className="mt-2 text-xs font-semibold text-white/45">{post.status}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

function Results() {
  return (
    <SectionShell id="results">
      <div className="grid items-start gap-10 lg:grid-cols-[0.95fr_1.05fr]">
        <div>
          <SectionIntro
            align="left"
            title={
              <>
                Results that answer <span className="text-gradient">what worked</span>
              </>
            }
            description="Business-readable reporting matters more than ornamental motion. This section stays static, immediate, and readable on mobile."
          />

          <div className="rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
            <p className="text-sm font-semibold text-white">What to do now</p>
            <p className="mt-3 text-lg font-semibold text-white">Keep the best-performing offer and schedule the next approved creative for Friday morning.</p>
            <p className="mt-4 text-sm leading-7 text-white/60">
              Aries keeps the complex work behind the scenes so you can focus on the decisions that matter for your business.
            </p>
          </div>
        </div>

        <div className="grid gap-4">
          {RESULT_METRICS.map((metric) => (
            <article key={metric.label} className="glass rounded-[2rem] p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">{metric.label}</p>
              <p className="mt-4 text-4xl font-bold text-white">{metric.value}</p>
              <p className="mt-3 text-sm leading-7 text-white/55">{metric.detail}</p>
            </article>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function Pricing() {
  return (
    <SectionShell>
      <SectionIntro
        title="Simple, Transparent Pricing"
        description="Choose the plan that fits your growth stage."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <article
            key={plan.name}
            className={cn(
              'glass relative flex h-full flex-col rounded-[2rem] p-8',
              plan.highlight ? 'border-primary/45 shadow-[0_24px_70px_rgba(124,58,237,0.18)]' : '',
            )}
          >
            {plan.highlight ? (
              <div className="mb-5 inline-flex w-fit rounded-full bg-primary px-4 py-1 text-xs font-bold uppercase tracking-[0.18em] text-white">
                Most Popular
              </div>
            ) : null}

            <h3 className="text-2xl font-bold text-white">{plan.name}</h3>
            <p className="mt-3 text-4xl font-bold text-white">{plan.price}</p>
            <p className="mt-4 text-sm leading-7 text-white/55">{plan.description}</p>

            <div className="mt-8 space-y-4">
              {plan.features.map((feature) => (
                <div key={feature} className="flex items-start gap-3">
                  <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary/15">
                    <Check className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <span className="text-sm leading-6 text-white/75">{feature}</span>
                </div>
              ))}
            </div>

            <Link
              href="/onboarding/start"
              className={cn(
                'mt-8 inline-flex min-h-12 items-center justify-center rounded-2xl px-6 text-sm font-bold text-white transition-colors',
                plan.highlight ? 'bg-gradient-to-r from-primary to-secondary hover:opacity-90' : 'bg-white/10 hover:bg-white/15',
              )}
            >
              {plan.price === 'Custom' ? 'Contact us' : 'Get started'}
            </Link>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}

function FinalCTA() {
  return (
    <SectionShell className="pt-8">
      <div className="overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/[0.04] p-8 md:p-12">
        <div className="grid items-center gap-10 lg:grid-cols-[0.95fr_1.05fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/35">Ready when you are</p>
            <h2 className="mt-5 max-w-2xl text-4xl font-bold leading-tight md:text-[3.2rem]">
              Start with your business and keep every marketing launch readable.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-8 text-white/60">
              Aries gives you one place to review the plan, approve the creative, confirm the schedule, and see what worked.
            </p>

            <div className="mt-8 flex flex-col gap-4 sm:flex-row">
              <Link
                href="/onboarding/start"
                className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary to-secondary px-8 text-base font-semibold text-white shadow-xl shadow-primary/20 transition-opacity hover:opacity-90"
              >
                Start with your business <ArrowRight className="h-5 w-5" />
              </Link>
              <Link
                href="/#how-it-works"
                className="inline-flex min-h-14 items-center justify-center rounded-full border border-white/12 bg-white/5 px-8 text-base font-semibold text-white transition-colors hover:bg-white/10"
              >
                See how it works
              </Link>
            </div>
          </div>

          <div className="relative min-h-[22rem]">
            <div className="absolute left-0 top-10 w-[78%] rounded-[2rem] border border-white/10 bg-black/45 p-5 shadow-2xl shadow-black/40">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Plan</p>
              <p className="mt-3 text-lg font-semibold text-white">Campaign ready for owner review</p>
              <p className="mt-3 text-sm leading-7 text-white/55">Clear brief, clear creative direction, clear launch window.</p>
            </div>

            <div className="absolute right-0 top-0 w-[72%] rounded-[2rem] border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-black/35">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Review</p>
              <p className="mt-3 text-lg font-semibold text-white">Nothing goes live without your approval</p>
              <p className="mt-3 text-sm leading-7 text-white/55">Material edits come back through review before launch.</p>
            </div>

            <div className="absolute bottom-0 right-10 w-[76%] rounded-[2rem] border border-white/10 bg-primary/12 p-5 shadow-2xl shadow-primary/10">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Results</p>
              <p className="mt-3 text-lg font-semibold text-white">One summary. One next move.</p>
              <p className="mt-3 text-sm leading-7 text-white/60">The route keeps the product story in fast static markup instead of shipping a third-party 3D runtime.</p>
            </div>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

export default function DonorHomePage() {
  return (
    <DonorMarketingShell>
      <Hero />
      <TrustedBy />
      <MeetAries />
      <Problem />
      <Features />
      <HowItWorks />
      <SafetyAndSchedule />
      <Results />
      <Pricing />
      <FinalCTA />
    </DonorMarketingShell>
  );
}
