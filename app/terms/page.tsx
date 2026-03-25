import MarketingLayout from '@/frontend/marketing/MarketingLayout';

const SECTIONS = [
  {
    title: 'Service scope',
    body: 'Aries provides campaign orchestration, marketing workflow automation, and related analytics surfaces for tenant-authorized operators.',
  },
  {
    title: 'Acceptable use',
    body: 'You agree to use the service for lawful business activity and avoid content that violates platform rules, intellectual property rights, or privacy obligations.',
  },
  {
    title: 'Data handling',
    body: 'Campaign inputs and generated artifacts are processed for workflow execution and status reporting. Tenant boundaries and route authorization controls apply.',
  },
  {
    title: 'Operational changes',
    body: 'The service may evolve over time. Material updates to these terms should be reviewed periodically by account owners and operators.',
  },
] as const;

export default function TermsPage() {
  return (
    <MarketingLayout>
      <section className="container mx-auto px-6 pt-32 pb-20">
        <div className="max-w-4xl space-y-8">
          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Legal</p>
            <h1 className="text-4xl font-bold mb-3">Terms of Service</h1>
            <p className="text-white/60">
              These terms summarize the service boundary for Aries runtime and campaign operations.
            </p>
          </div>
          <div className="grid gap-4">
            {SECTIONS.map((section) => (
              <article key={section.title} className="glass rounded-[2rem] p-6">
                <h2 className="text-2xl font-semibold mb-2">{section.title}</h2>
                <p className="text-white/70 leading-relaxed">{section.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
