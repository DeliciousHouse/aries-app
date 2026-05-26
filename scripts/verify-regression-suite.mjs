import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const candidateRoot = explicitCodeRoot ? path.resolve(explicitCodeRoot) : null;
const repoRoot =
  candidateRoot && fs.existsSync(path.join(candidateRoot, 'package.json'))
    ? candidateRoot
    : process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const nextBin = path.join(repoRoot, 'node_modules', '.bin', 'next');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

const baseEnv = {
  ...process.env,
  NODE_ENV: 'development',
  CODE_ROOT: repoRoot,
  APP_BASE_URL: 'https://aries.example.com',
  NEXTAUTH_URL: 'https://aries.example.com',
  AUTH_URL: 'https://aries.example.com',
  AUTH_TRUST_HOST: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
};

// --- Route-handler type gate ---
// Next.js generates .next/types/**/*.ts during `next typegen` (or build).
// These files define RouteHandlerConfig<Route> constraints that plain tsc
// never sees unless typegen has been run first. This two-step check catches
// the class of errors that triggered the Deploy failure in PR #283/#284
// (second-arg signature mismatch on a route handler).
const typegenSteps = [
  { label: 'next typegen', bin: nextBin, args: ['typegen', '.'] },
  { label: 'tsc --noEmit',  bin: tscBin,  args: ['--noEmit'] },
];

console.log('\n[verify route-type gate] next typegen + tsc --noEmit');
for (const { label, bin, args } of typegenSteps) {
  const result = spawnSync(bin, args, { cwd: repoRoot, env: baseEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    console.error(`\nRoute-type gate failed at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

// --- tsx test steps ---
const steps = [
  {
    name: 'public-route smoke tests',
    args: ['--test', 'tests/runtime-pages.test.ts'],
  },
  {
    name: 'process-concurrent helper',
    args: ['--test', 'tests/process-concurrent.test.ts'],
  },
  {
    // PRD §20 canonical behavioral invariants — codified as runtime checks so
    // future PRs get a green/red CI signal on spec conformance.  See
    // tests/prd-invariants/README.md and docs/product/aries-ai-prd.md §20.
    name: 'PRD §20 invariant suite',
    args: [
      '--test',
      'tests/prd-invariants/inv-01-aries-owns-tenant-boundaries.test.ts',
      'tests/prd-invariants/inv-02-hermes-not-state-owner.test.ts',
      'tests/prd-invariants/inv-03-honcho-approved-memory-only.test.ts',
      'tests/prd-invariants/inv-04-tenant-derived-server-side.test.ts',
      'tests/prd-invariants/inv-05-hermes-native-default.test.ts',
      'tests/prd-invariants/inv-06-openclaw-lobster-compat-only.test.ts',
      'tests/prd-invariants/inv-07-publishing-requires-approval.test.ts',
      'tests/prd-invariants/inv-08-video-render-requires-approval.test.ts',
      'tests/prd-invariants/inv-09-ai-content-draft-until-approved.test.ts',
      'tests/prd-invariants/inv-10-memory-curated-append-only.test.ts',
      'tests/prd-invariants/inv-11-no-cross-tenant-memory.test.ts',
      'tests/prd-invariants/inv-12-no-credentials-in-payloads.test.ts',
      'tests/prd-invariants/inv-13-workflow-transitions-explicit.test.ts',
      'tests/prd-invariants/inv-14-callbacks-authn-schema-tenant-idemp.test.ts',
      'tests/prd-invariants/inv-15-capability-ports-not-vendor.test.ts',
      'tests/prd-invariants/inv-01b-state-mutating-routes-auth-gate.test.ts',
    ],
  },
  {
    name: 'banned-pattern assertions',
    args: ['--test', 'tests/verify-banned-patterns.test.ts'],
  },
  {
    name: 'repo-boundary guard',
    args: ['--test', 'tests/repo-boundary-guard.test.ts'],
  },
  {
    name: 'execution provider and Hermes callback smoke tests',
    args: [
      '--test',
      'tests/execution-provider-selection.test.ts',
      'tests/execution-hermes-adapter.test.ts',
      'tests/hermes-callback-route.test.ts',
      'tests/execution-run-store.test.ts',
      'tests/marketing-execution-port.test.ts',
      'tests/marketing-hermes-callback-flow.test.ts',
      'tests/marketing/resolve-stage-output.test.ts',
      'tests/marketing/workspace-views-primary-output.test.ts',
      'tests/marketing/asset-library-primary-output.test.ts',
      'tests/marketing/callback-auto-approve.test.ts',
      'tests/marketing/stage-summary-state-aware.test.ts',
    ],
  },
  {
    name: 'social-content migration regression tests',
    args: [
      '--test',
      'tests/marketing/workflow-request-fallback.test.ts',
      'tests/social-content-execution-contract.test.ts',
      'tests/social-content-weekly-defaults.test.ts',
      'tests/social-content-approve-route.test.ts',
      'tests/integrations-openai-safety.test.ts',
      'tests/social-content-new-job-screen.test.ts',
      'tests/marketing-job-route.smoke.test.ts',
      'tests/runtime-pages.test.ts',
      'tests/docs-social-content-guidance.test.ts',
      'tests/social-content-public-copy.test.ts',
    ],
  },
  {
    name: 'partner attribution (VMS) unit tests',
    args: [
      '--test',
      'tests/partner-ref-cookie.test.ts',
      'tests/vms-client.test.ts',
      'tests/partner-outbox.test.ts',
      'tests/partner-attribution-schema.test.ts',
    ],
  },
  {
    // Added 2026-05-23 after a 30-day P0 backlog of failing contract tests
    // accumulated unblocked because verify was narrower than the full suite.
    // These files are the ones whose drift triggered the backlog (Lobster
    // python-script removal, OAuth memory->Postgres swap, execution-port seam
    // swap, tenant-scoped artifact paths, public-surface copy, CodeQL
    // hostname checks). Keep this step under ~35s wall-clock; if a test
    // here regresses, prefer fixing the test contract over removing the file.
    //
    // Deliberately excluded (still tracked in CI's full suite):
    //   - tests/frontend-api-layer.test.ts (~70s; needs split)
    //   - tests/marketing-brand-identity-parity.test.ts (~64s; investigate hot loop)
    name: 'post-30-day-backlog contract regression tests',
    args: [
      '--test',
      'tests/onboarding-draft-route.test.ts',
      'tests/auth/oauth-connect.test.ts',
      'tests/auth/integrations-tenant-context.test.ts',
      'tests/integrations-status.test.ts',
      'tests/oauth-callback-runtime.test.ts',
      'tests/oauth-refresh-meta.test.ts',
      'tests/marketing-validated-runtime.test.ts',
      'tests/review-surfaces-public.test.ts',
      'tests/public-generated-routes.test.ts',
    ],
  },
];

for (const [index, step] of steps.entries()) {
  console.log(`\n[verify ${index + 1}/${steps.length}] ${step.name}`);
  const result = spawnSync(tsxBin, step.args, {
    cwd: repoRoot,
    env: baseEnv,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\nVerification suite passed.');
