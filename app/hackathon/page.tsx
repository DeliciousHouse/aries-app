import type { Metadata } from 'next';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import HackathonRegistrationForm from '../../frontend/hackathon/registration-form';

// Direct-URL only. Not linked from anywhere in nav. The robots metadata below
// keeps the page out of search engines so the URL stays "share-only" the way
// the page operator intended.
export const metadata: Metadata = {
  title: 'Aries AI Hackathon — Register',
  description: 'Build something real with Aries AI. Registration is invite-only via direct link.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

// EDIT ME: tune copy + dates for the actual event without touching the form
// or routing infrastructure.
const HACKATHON = {
  name: 'Aries AI Hackathon',
  tagline: 'Build something real with Aries AI in 48 hours.',
  registrationDeadline: 'June 10, 2026',
  eventWindow: 'June 12 – June 14, 2026',
  format: 'Virtual, async-first. Final demos live on June 14.',
  prize: 'Top three teams get featured on the Aries blog + direct intro to the team.',
  what: [
    'Pick a real marketing problem -- yours or one we pose.',
    'Ship a working Aries integration, automation, or agent.',
    'Submit a 3-minute demo video by the deadline.',
  ],
  who: 'Builders, marketers, designers, students. Solo or teams up to 4.',
};

export default function HackathonPage() {
  return (
    <MarketingLayout>
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6">
          <div className="max-w-4xl mx-auto">
            <div className="glass rounded-[2.5rem] p-8 md:p-12">
              <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
                Invite-only · Direct link
              </span>
              <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
                {HACKATHON.name.split(' ').slice(0, -1).join(' ')}{' '}
                <span className="text-gradient">{HACKATHON.name.split(' ').slice(-1)[0]}</span>
              </h1>
              <p className="text-xl text-white/70 mb-10 leading-relaxed">
                {HACKATHON.tagline}
              </p>

              <div className="grid sm:grid-cols-2 gap-4 mb-10">
                <FactCard label="Registration closes" value={HACKATHON.registrationDeadline} />
                <FactCard label="Event window" value={HACKATHON.eventWindow} />
                <FactCard label="Format" value={HACKATHON.format} />
                <FactCard label="Who" value={HACKATHON.who} />
              </div>

              <div className="mb-10">
                <h2 className="text-2xl font-semibold mb-4">What you&apos;ll do</h2>
                <ul className="space-y-2 text-white/75">
                  {HACKATHON.what.map((item) => (
                    <li key={item} className="flex gap-3">
                      <span className="text-primary mt-1">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-10 rounded-2xl border border-primary/20 bg-primary/5 p-6">
                <p className="text-sm uppercase tracking-[0.2em] text-primary font-semibold mb-2">
                  Prize
                </p>
                <p className="text-white/80">{HACKATHON.prize}</p>
              </div>

              <HackathonRegistrationForm deadlineLabel={HACKATHON.registrationDeadline} />

              <p className="mt-10 text-sm text-white/70">
                Questions? Email{' '}
                <a
                  href="mailto:support@sugarandleather.com?subject=Aries%20AI%20Hackathon"
                  className="underline decoration-primary/60 underline-offset-4 hover:text-white"
                >
                  support@sugarandleather.com
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}

function FactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-white/70 font-semibold mb-1">{label}</p>
      <p className="text-white/85">{value}</p>
    </div>
  );
}
