import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  LineChart,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';

const pillars = [
  {
    title: 'See the plan',
    body: 'Aries turns your business goals into a campaign plan you can read in seconds.',
    icon: Sparkles,
  },
  {
    title: 'Approve safely',
    body: 'Every creative draft and launch stays reviewable. Nothing goes live without your approval.',
    icon: ShieldCheck,
  },
  {
    title: 'Launch clearly',
    body: 'Scheduling stays human-readable so you always know what is running and what is next.',
    icon: CalendarClock,
  },
  {
    title: 'Improve what works',
    body: 'Results are translated into simple next steps so you know where to focus next.',
    icon: LineChart,
  },
];

const productLoop = [
  'Set up your business',
  'See the plan',
  'Review the creative',
  'Launch safely',
  'See what worked',
];

export default function AriesLandingPage() {
  return (
    <main className="min-h-screen bg-[#0c1117] text-white">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.12),transparent_28%),radial-gradient(circle_at_80%_20%,rgba(208,150,90,0.14),transparent_22%),linear-gradient(180deg,#101721_0%,#0c1117_55%,#121b24_100%)]" />
        <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 pb-16 pt-8 lg:px-10">
          <header className="flex items-center justify-between gap-4 py-4">
            <Link href="/" className="inline-flex items-center gap-3">
              <AriesMark sizeClassName="h-11 w-11" />
              <div>
                <p className="text-sm font-semibold tracking-[0.18em] text-white/55 uppercase">Aries AI</p>
                <p className="text-xs text-white/40">Marketing operating system</p>
              </div>
            </Link>
            <div className="hidden items-center gap-6 text-sm text-white/60 md:flex">
              <a href="#how-it-works" className="transition hover:text-white">
                How it works
              </a>
              <a href="#safety" className="transition hover:text-white">
                Safety
              </a>
              <a href="#results" className="transition hover:text-white">
                Results
              </a>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="/login"
                className="hidden rounded-full border border-white/12 px-4 py-2 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white md:inline-flex"
              >
                Sign in
              </Link>
              <Link
                href="/onboarding/start"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
              >
                Start with your business
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </header>

          <section className="grid flex-1 items-center gap-10 py-16 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="max-w-3xl space-y-8">
              <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm text-white/70">
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                Nothing goes live without your approval.
              </div>
              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#dcb58f]">
                  Premium marketing control for small businesses
                </p>
                <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.04em] text-white md:text-7xl">
                  Plan, create, approve, launch, and improve your marketing from one calm workspace.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-white/65">
                  Aries gives business owners a simple place to see what is running, what needs approval,
                  what is scheduled next, what is working, and what to do now.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  href="/onboarding/start"
                  className="inline-flex items-center gap-2 rounded-full bg-[#f4efe6] px-6 py-3.5 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
                >
                  Start with your business
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/documentation"
                  className="inline-flex items-center gap-2 rounded-full border border-white/12 px-6 py-3.5 text-sm font-semibold text-white/80 transition hover:border-white/20 hover:text-white"
                >
                  See the product surface
                </Link>
              </div>
            </div>

            <div className="rounded-[2.4rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.03))] p-5 shadow-[0_32px_120px_rgba(0,0,0,0.35)] backdrop-blur-xl">
              <div className="rounded-[2rem] border border-white/10 bg-[#0f151b] p-5">
                <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Home</p>
                    <h2 className="mt-2 text-2xl font-semibold text-white">Your marketing this week</h2>
                  </div>
                  <span className="rounded-full bg-amber-300/12 px-3 py-1.5 text-xs font-medium text-amber-50">
                    3 approvals waiting
                  </span>
                </div>
                <div className="grid gap-4 py-5 md:grid-cols-2">
                  <div className="rounded-[1.5rem] border border-white/8 bg-white/[0.04] p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Next action</p>
                    <p className="mt-3 text-base font-semibold text-white">Approve the Spring Membership Drive launch set</p>
                    <p className="mt-2 text-sm leading-6 text-white/55">
                      Three items are ready for review. Once approved, Aries can schedule the first week.
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-white/8 bg-white/[0.04] p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Scheduled next</p>
                    <p className="mt-3 text-base font-semibold text-white">Thu, Apr 2 at 8:30 AM</p>
                    <p className="mt-2 text-sm leading-6 text-white/55">
                      Approved Instagram member story queued for the next cycle.
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-white/8 bg-white/[0.04] p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Working now</p>
                    <p className="mt-3 text-base font-semibold text-white">27 booked consults</p>
                    <p className="mt-2 text-sm leading-6 text-emerald-200">
                      March Open House is pacing 18% ahead of target.
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] border border-white/8 bg-white/[0.04] p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Trust</p>
                    <p className="mt-3 text-base font-semibold text-white">Every launch stays reviewable</p>
                    <p className="mt-2 text-sm leading-6 text-white/55">
                      Material edits return to review before scheduling continues.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
        <div className="mb-12 max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">How it works</p>
          <h2 className="mt-4 text-4xl font-semibold tracking-[-0.03em] text-white">
            Aries compresses complexity into one simple rhythm.
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-5">
          {productLoop.map((step, index) => (
            <div
              key={step}
              className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] px-5 py-6"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/35">0{index + 1}</p>
              <p className="mt-4 text-lg font-medium text-white">{step}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="safety" className="border-y border-white/8 bg-white/[0.02]">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-18 md:grid-cols-2 lg:grid-cols-4 lg:px-10">
          {pillars.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <article
                key={pillar.title}
                className="rounded-[1.8rem] border border-white/8 bg-[#121923] px-5 py-6"
              >
                <div className="inline-flex rounded-full bg-white/[0.06] p-3">
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <h3 className="mt-4 text-xl font-semibold text-white">{pillar.title}</h3>
                <p className="mt-3 text-sm leading-7 text-white/60">{pillar.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section id="results" className="mx-auto max-w-7xl px-6 py-20 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-5">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">Results</p>
            <h2 className="text-4xl font-semibold tracking-[-0.03em] text-white">
              Business-readable reporting, not a maze of marketing charts.
            </h2>
            <p className="text-lg leading-8 text-white/65">
              Aries translates campaign performance into a clear summary, a recommendation, and the next safe action.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Booked consults</p>
              <p className="mt-4 text-4xl font-semibold text-white">27</p>
              <p className="mt-2 text-sm text-emerald-200">+18% vs goal</p>
            </div>
            <div className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Cost per booking</p>
              <p className="mt-4 text-4xl font-semibold text-white">$22</p>
              <p className="mt-2 text-sm text-emerald-200">11% below target</p>
            </div>
            <div className="rounded-[1.8rem] border border-white/8 bg-white/[0.03] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Next move</p>
              <p className="mt-4 text-lg font-semibold text-white">Approve the winning variation</p>
              <p className="mt-2 text-sm text-white/60">Extend the highest-performing message before fatigue appears.</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/8 px-6 py-8 text-sm text-white/45 lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <p>Aries AI is built for small businesses that want marketing results without marketing software overhead.</p>
          <div className="flex flex-wrap items-center gap-4">
            <Link href="/privacy" className="transition hover:text-white">
              Privacy
            </Link>
            <Link href="/terms" className="transition hover:text-white">
              Terms
            </Link>
            <Link href="/login" className="transition hover:text-white">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
