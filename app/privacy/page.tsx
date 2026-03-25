import MarketingLayout from '@/frontend/marketing/MarketingLayout';

const PRINCIPLES = [
  'Collect only data needed to run tenant workflows and show runtime status.',
  'Use tenant context and authorization checks to prevent cross-tenant access.',
  'Keep generated artifacts and approval states in controlled runtime storage.',
  'Limit browser responses to safe DTOs and authenticated asset routes.',
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
              This policy outlines how Aries handles tenant campaign data and runtime artifacts.
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
        </div>
      </section>
    </MarketingLayout>
  );
}
