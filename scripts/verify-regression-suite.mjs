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
    name: 'in-app feedback button (validation, sink schema, config gating, widget)',
    args: [
      '--test',
      'tests/feedback-submission-validation.test.ts',
      'tests/feedback-sink.test.ts',
      'tests/feedback-jira-sink.test.ts',
      'tests/feedback-config.test.ts',
      'tests/feedback-severity-classifier.test.ts',
      'tests/feedback-widget-render.test.ts',
    ],
  },
  {
    name: 'customer incident reports (SC-70 port: impact map, ADF, Jira client, sync, sweep, dialog logic)',
    args: [
      '--test',
      'tests/feedback-report-impact.test.ts',
      'tests/feedback-report-screenshot.test.ts',
      'tests/feedback-report-adf.test.ts',
      'tests/feedback-report-jira-client.test.ts',
      'tests/feedback-report-validation.test.ts',
      'tests/feedback-report-sync.test.ts',
      'tests/feedback-report-submit.test.ts',
      'tests/feedback-report-sweep.test.ts',
      'tests/feedback-report-form.test.ts',
      'tests/feedback-report-dialog.test.ts',
    ],
  },
  {
    name: 'headless QA sandbox session tooling (pinned identity, TTL clamp, cookie shape)',
    args: ['--test', 'tests/qa-session-lib.test.ts'],
  },
  {
    name: 'process-concurrent helper',
    args: ['--test', 'tests/process-concurrent.test.ts'],
  },
  {
    name: 'Honcho writes V0-V19 verification harness',
    args: ['--test', 'tests/verify-honcho-writes.test.ts'],
  },
  {
    // Regression for the 2026-06-09 prod wedge: a failed tick must release the
    // insights-sync worker's overlap guard. Fast and fully in-memory.
    name: 'insights-sync worker tick guard',
    args: ['--test', 'tests/insights-sync-worker-tick-reset.test.ts'],
  },
  {
    // Regression for the PR #581 review finding: a SIGTERM mid-tick strands
    // insights_sync_runs rows in status='running' forever. Every tick must
    // sweep stranded rows (behind a grace window) without costing tenants
    // their sync. Fast and fully in-memory.
    name: 'insights-sync stranded-run sweep',
    args: ['--test', 'tests/insights-sync-worker-stranded-runs.test.ts'],
  },
  {
    // S2-4/AA-95: day-boundary timezone AGREEMENT guardrail. Pure + no DB, so it
    // runs here on every PR (unlike the S2-3/S2-1 requires-infra tz tests that
    // self-skip in CI). Fails if audience or attention reverts to UTC bucketing.
    name: 'insights day-boundary tz agreement (audience + attention)',
    args: ['--test', 'tests/insights-tz-boundary-agreement.test.ts'],
  },
  {
    // S3-1/AA-97: honesty pass — no fabricated numbers posing as measured stats.
    // Dead account scores 0 (not ~50); one shared hoursSaved estimate; whyItWorked
    // uses the real multiplier not a hardcoded 1.5x/1.7x; and a copy tripwire
    // against "design accounts" / "1-3.5%" / "N.Nx your ..." reintroduction. No DB.
    name: 'insights honesty pass (no fabricated stats)',
    args: ['--test', 'tests/insights-honesty-pass.test.ts'],
  },
  {
    // 2026-07-13 duplicate-posting incident (AA-134 / PR #841) regression wall:
    // scheduler day-mapping + same-instant de-collision, the reel-companion
    // synthesis clamp, the publish-boundary duplicate/spacing guards, and the
    // worker retry backoff (incl. the crash-safety tick harness that drives the
    // backoff write site). Pure + in-memory fakes, no DB — a regression here
    // means Aries can burst-post or retry-hammer a platform again.
    name: 'duplicate-posting incident wall (scheduler, guards, backoff)',
    args: [
      '--test',
      'tests/duplicate-posting-guards.test.ts',
      'tests/scheduled-posts-worker-backoff.test.ts',
      'tests/scheduled-posts-worker-crash-safety.test.ts',
    ],
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
    // Compose-service vs deploy-workflow recreate parity. In verify (not just
    // the CI full-suite) because the agent-automerge deploy path gates on
    // verify alone — a compose/deploy drift must fail before that dispatch.
    name: 'deploy manifest parity',
    args: ['--test', 'tests/deploy-manifest-parity.test.ts'],
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
      'tests/marketing/list-deleted-posts-bounded-parallel.test.ts',
      'tests/runtime-views-list-projection.test.ts',
      'tests/marketing/review-queue-skips-failed-jobs.test.ts',
      'tests/marketing/strategy-review-summary-no-objective-fallback.test.ts',
      'tests/marketing-job-retry-research.test.ts',
      'tests/marketing-auto-schedule.test.ts',
      'tests/auto-schedule-posting-overrides.test.ts',
      'tests/marketing/draft-expiry-sweep.test.ts',
      'tests/meta-media-validation.test.ts',
      'tests/meta-publishing-video.test.ts',
      'tests/hermes-callback-video-surface.test.ts',
      'tests/synthesize-publish-posts-surface.test.ts',
      'tests/marketing/publish-skip-synthesize-posts.test.ts',
      'tests/social-content-cancel-schedule.test.ts',
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
    // AI-derived per-platform posting times (ARIES_AI_POSTING_TIMES_ENABLED):
    // env flag, advisor derivation (analytics threshold + competitor Hermes
    // leg, all fail-open), and the settings GET/derive routes. Fully
    // in-memory; the slot-override compute tests ride the execution-provider
    // step above with the other auto-schedule tests.
    name: 'AI posting-time advisor',
    args: [
      '--test',
      'tests/posting-times-env.test.ts',
      'tests/posting-time-advisor.test.ts',
      'tests/posting-times-route.test.ts',
      'tests/settings-screen.test.ts',
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
  {
    // honcho-performance-insights (delayed real-Meta perf -> Honcho memory).
    // Fixture-primary: payload builder + due-posts SQL shape + worker tick
    // (mocked recordPerformanceEvent). The #513 (insights_*) live-DB legs are
    // separate (tests/memory/perf-insights-live-db.test.ts) and #513-gated.
    name: 'honcho performance-insights unit tests',
    args: [
      '--test',
      'tests/memory/perf-insights-payload.test.ts',
      'tests/memory/perf-insights-read.test.ts',
      'tests/memory/honcho-performance-worker.test.ts',
    ],
  },
  {
    name: 'onboarding variant-board taste-profile unit tests',
    args: [
      '--test',
      'tests/onboarding/variant-board-flag.test.ts',
      'tests/onboarding/taste-profile-store.test.ts',
    ],
  },
  {
    name: 'onboarding variant fan-out + board unit tests',
    args: [
      '--test',
      'tests/onboarding/ingest-variant-tags.test.ts',
      'tests/onboarding/ingest-variant-binding.test.ts',
      'tests/onboarding/variant-fanout.test.ts',
      'tests/onboarding/variant-board.test.ts',
      'tests/onboarding/variant-pick.test.ts',
      'tests/onboarding/variant-endpoints.test.ts',
      'tests/onboarding/variant-pick-finalize.test.ts',
    ],
  },
  {
    name: 'onboarding variant board render (jsdom)',
    args: ['--test', 'tests/onboarding/variant-board-render.component.test.ts'],
  },
  {
    // #705 regression: calendar-presenter must open on the current month, not
    // the earliest queued event (which could be months in the past).
    name: 'calendar initial-month regression (#705)',
    args: ['--test', 'tests/calendar-initial-month.test.ts'],
  },
  {
    // #684 regression: analytics screen must gate the summary grid + Views column
    // on per-platform capabilities (account_daily_metrics / post_view_count) and
    // render an honest EmptyStatePanel — not fabricated zeros — for unsupported
    // platforms (x, reddit, linkedin for grid; x/reddit/linkedin for Views column).
    name: 'insights dashboard UI source assertions (#648, #684)',
    args: ['--test', 'tests/insights-dashboard-ui.test.ts'],
  },
  {
    // Multi-workspace membership Phase 0.5 (absorb-orphan invite relief). These
    // are security-invariant unit tests (in-txn orphan re-check, no-password-write
    // on absorb, admin-chosen-role-never-carried-over, consent-auth, decline kills
    // the token, idempotent double-accept). Fully in-memory SQL-routing fakes — no
    // DB, no DATA_ROOT — so they are safe under --test-concurrency=1. Previously
    // these tenant unit tests rode CI's full-suite only; gate them in verify too so
    // an absorb-flow regression is caught pre-push, not just at the merge gate.
    name: 'tenant workspace-invitations + absorb-orphan (Phase 0.5)',
    args: [
      '--test',
      'tests/tenant/workspace-invitations.test.ts',
      'tests/tenant/workspace-invitations-absorb-adversarial.test.ts',
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
