import Link from 'next/link';

import MarketingLayout from '../../frontend/marketing/MarketingLayout';

export default function ContactPage() {
  return (
    <MarketingLayout>
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6">
          <div className="max-w-4xl glass rounded-[2.5rem] p-8 md:p-12">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Contact
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Contact intake stays inside the <span className="text-gradient">Aries route boundary</span>
            </h1>
            <p className="text-xl text-white/60 mb-8">
              No contact workflow is deployed in this runtime today. The supported interface is the internal
              <code className="mx-1 text-white">/api/contact</code> route, which returns an explicit unavailable
              response until a real adapter is configured.
            </p>

            <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-6 font-mono text-sm text-white/75 mb-8">
              POST /api/contact
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/api-docs"
                className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20"
              >
                Review the API
              </Link>
              <Link
                href="/documentation"
                className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all"
              >
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
