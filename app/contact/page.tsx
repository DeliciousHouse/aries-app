import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Link from 'next/link';
export default function ContactPage() {
  return (
    <MarketingLayout>
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6 max-w-5xl space-y-8">
          <div>
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Contact
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Questions about the <span className="text-gradient">Aries runtime?</span>
            </h1>
            <p className="text-xl text-white/60">
              The public contact route remains available so the URL stays stable, but submissions are intentionally disabled until a real intake workflow exists.
            </p>
          </div>

          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <div className="rounded-2xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent p-5 mb-6">
              <strong className="block mb-2 text-red-100">No contact workflow is deployed</strong>
              <span className="text-red-50/90 text-sm">
                <code>/api/contact</code> currently returns an explicit placeholder response instead of accepting submissions.
              </span>
            </div>
            <p className="text-white/60 text-lg mb-8">
              This page stays live to preserve routing and explain the current contract honestly. If you need implementation details, the runtime and API docs describe the current boundary in full.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link href="/documentation" className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 text-center">
                Read the docs
              </Link>
              <Link href="/api-docs" className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                Review the API
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
