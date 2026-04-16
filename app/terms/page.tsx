import MarketingLayout from '@/frontend/marketing/MarketingLayout';

export const metadata = {
  title: 'Terms of Service — Aries AI',
};

const SECTIONS = [
  {
    title: 'What Aries does',
    body: 'Aries plans, creates, and helps you launch marketing campaigns. You can review every piece of work before anything goes live.',
  },
  {
    title: 'Acceptable use',
    body: 'You agree to use Aries for lawful business activity and to follow each ad platform\u2019s own rules. Don\u2019t use Aries to create content that infringes copyright, violates privacy, or misleads people.',
  },
  {
    title: 'Your data',
    body: 'We use the information you provide to generate campaigns and show you the status of your work. We don\u2019t share your campaign data with other customers, and we don\u2019t sell it.',
  },
  {
    title: 'Changes to these terms',
    body: 'We may update these terms as the product evolves. When we make material changes, we\u2019ll notify account owners so you have time to review.',
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
              A plain-language summary of what Aries does for you and what we expect from you.
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
