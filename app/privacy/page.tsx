import MarketingLayout from '@/frontend/marketing/MarketingLayout';

export const metadata = {
  title: 'Privacy Policy — Aries AI',
};

const PRINCIPLES = [
  'We only collect the information needed to run your campaigns and show you the status of your work.',
  'Your campaign data stays tied to your account — other customers cannot see it.',
  'Drafts, generated assets, and approval history are kept in secure storage that only your team can access.',
  'We never publish or launch anything without your explicit approval.',
] as const;

export default function PrivacyPage() {
  return (
    <MarketingLayout>
      <section className="container mx-auto px-6 pt-32 pb-20">
        <div className="max-w-4xl space-y-8">
          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Legal</p>
            <h1 className="text-4xl font-bold mb-3">Privacy Policy</h1>
            <p className="text-white/60">
              This policy explains what information Aries collects to run your marketing campaigns and how it&apos;s protected.
            </p>
          </div>
          <div className="glass rounded-[2rem] p-6">
            <ul className="space-y-4 text-white/70">
              {PRINCIPLES.map((principle) => (
                <li key={principle} className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                  {principle}
                </li>
              ))}
            </ul>
          </div>
          <div className="glass rounded-[2rem] p-6 text-white/70 leading-relaxed">
            <p>
              Questions about your data or want to request export or deletion? Email{' '}
              <a href="mailto:support@sugarandleather.com" className="underline hover:text-white">
                support@sugarandleather.com
              </a>
              .
            </p>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
