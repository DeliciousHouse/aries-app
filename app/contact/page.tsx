import React from 'react';

import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Link from 'next/link';
export default function ContactPage() {
  return (
    <MarketingLayout>
      <section className="public-page-section">
        <div className="container max-w-5xl space-y-6 md:space-y-8">
          <div>
            <span className="eyebrow mb-6">
              Contact
            </span>
            <h1 className="public-heading-lg mb-6 max-w-4xl">
              Questions about the <span className="text-gradient">Aries runtime?</span>
            </h1>
            <p className="public-subcopy">
              The public contact route remains available so the URL stays stable, but submissions are intentionally disabled until a real intake workflow exists.
            </p>
          </div>

          <div className="glass rounded-[2rem] p-6 md:p-8 lg:p-10">
            <div className="mb-6 rounded-[1.5rem] border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent p-5">
              <strong className="mb-2 block text-red-100">No contact workflow is deployed</strong>
              <span className="text-sm text-red-50/90">
                <code>/api/contact</code> currently returns an explicit placeholder response instead of accepting submissions.
              </span>
            </div>
            <p className="mb-8 text-base leading-8 text-white/70 md:text-lg">
              This page stays live to preserve routing and explain the current contract honestly. If you need implementation details, the runtime and API docs describe the current boundary in full.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link href="/documentation" className="inline-flex min-h-[3.25rem] items-center justify-center rounded-full bg-gradient-to-r from-primary to-secondary px-7 py-3.5 text-center text-base font-semibold text-white shadow-xl shadow-primary/20">
                Read the docs
              </Link>
              <Link href="/api-docs" className="inline-flex min-h-[3.25rem] items-center justify-center rounded-full border border-white/10 bg-white/5 px-7 py-3.5 text-center text-base font-semibold text-white transition-all hover:bg-white/10">
                Review the API
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
