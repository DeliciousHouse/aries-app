import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';

const SUMMARY_SECTIONS = [
  {
    title: 'Direct architecture',
    body: 'Aries serves public pages, authenticated operator pages, and internal API routes. The browser never calls workflow infrastructure directly.',
  },
  {
    title: 'Execution boundary',
    body: 'Aries validates the request, resolves auth and tenant context, and then either reads runtime state or calls OpenClaw for execution.',
  },
  {
    title: 'Verification',
    body: 'Route smoke checks, banned-pattern checks, marketing-flow smoke tests, and Lighthouse audits keep the documented contract aligned with the repo.',
  },
];

const COMMANDS = [
  'NODE_ENV=development npm ci',
  'cp .env.example .env',
  'export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev',
  'export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development',
  'export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true',
  'npx next dev -p 3000 --turbopack',
];

const VALIDATION = [
  './node_modules/.bin/tsx --test tests/runtime-pages.test.ts',
  'node scripts/check-banned-patterns.mjs',
  'APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts',
  "mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json",
];

export default function DocumentationPage() {
  return (
    <MarketingLayout>
      <section className="pt-36 pb-24">
        <div className="container mx-auto px-6 space-y-10">
          <div className="max-w-4xl">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-6">
              Documentation
            </span>
            <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
              Run Aries locally with a <span className="text-gradient">single direct architecture</span>
            </h1>
            <p className="text-xl text-white/60">
              The supported path is simple: public and operator routes in Next.js, browser-safe internal APIs, OpenClaw for execution, and runtime state stored server-side.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {SUMMARY_SECTIONS.map((section) => (
              <div key={section.title} className="glass rounded-[2rem] p-8">
                <h2 className="text-2xl font-bold mb-4">{section.title}</h2>
                <p className="text-white/55 leading-relaxed">{section.body}</p>
              </div>
            ))}
          </div>

          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-5">
              Quick start
            </span>
            <h2 className="text-3xl md:text-4xl font-bold mb-5">Local development flow</h2>
            <div className="space-y-3">
              {COMMANDS.map((command) => (
                <div key={command} className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 overflow-x-auto font-mono text-sm md:text-base text-white/75 break-all">
                  {command}
                </div>
              ))}
            </div>
          </div>

          <div className="glass rounded-[2.5rem] p-8 md:p-10">
            <span className="inline-flex px-4 py-2 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs uppercase tracking-[0.2em] font-semibold mb-5">
              Validation
            </span>
            <h2 className="text-3xl md:text-4xl font-bold mb-5">Commands engineers should run before shipping docs changes</h2>
            <div className="space-y-3">
              {VALIDATION.map((command) => (
                <div key={command} className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 overflow-x-auto font-mono text-sm md:text-base text-white/75 break-all">
                  {command}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
