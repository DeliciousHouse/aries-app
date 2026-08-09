import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const candidateRoot = explicitCodeRoot ? path.resolve(explicitCodeRoot) : null;
const repoRoot =
  candidateRoot && fs.existsSync(path.join(candidateRoot, 'package.json'))
    ? candidateRoot
    : process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nextBin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

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
  { label: 'next typegen', script: nextBin, args: ['typegen', '.'] },
  { label: 'tsc --noEmit', script: tscBin, args: ['--noEmit'] },
];

console.log('\n[verify route-type gate] next typegen + tsc --noEmit');
for (const { label, script, args } of typegenSteps) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: baseEnv,
    stdio: 'inherit',
  });
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
      'tests/feedback-report-submitter.test.ts',
      'tests/feedback-report-route.test.ts',
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
    // S6-5/AA-118 (gap F8): Approve/Edit/Reject for queued memory candidates —
    // the human gate `curator_decision='queue_for_review'` always implied but
    // never had. Pins the properties that make a memory write safe: a
    // cross-tenant finding is NOT FOUND (never confirmed to exist), an
    // already-settled one performs no second Honcho append, reject writes
    // nothing to memory at all, an edit promotes the operator's wording while
    // the stored candidate keeps its provenance, an unsupported peer or an
    // empty claim is refused rather than guessed, and Honcho being off still
    // records the decision while reporting the memory as pending. Injected
    // store + Honcho; no DB, no network.
    name: 'memory-candidate promotion route (F8)',
    args: ['--test', 'tests/memory-finding-resolve.test.ts'],
  },
  {
    // AA-159: task-execution engine classification. Pins the contracts the cost
    // analysis depends on — the engine vocabulary, hard-zero tokens on the
    // zero-cost engines vs NULL ("not reported") on AI rows, no model columns on
    // non-AI rows, the flag-OFF pass-through, and telemetry failures never
    // reaching the measured task. Fully in-memory (injected db).
    name: 'task-execution engine classification (AA-159)',
    args: [
      '--test',
      'tests/telemetry/task-execution-log.test.ts',
      'tests/telemetry/task-token-timing-telemetry.test.ts',
      'tests/telemetry/hermes-run-execution-log.test.ts',
      'tests/execution-run-engine-classification.test.ts',
    ],
  },
  {
    // AA-161: the usage time-series layer over the same raw table. Pins the
    // contracts a billing number depends on — only CLOSED hours are rolled,
    // re-rolling a window converges instead of double counting, the watermark
    // only moves forward, buckets are UTC, and the retention sweep can never
    // delete a raw row the rollup has not reached (fail-closed with no
    // watermark). Fully in-memory (injected db).
    name: 'usage rollups + retention + company daily view (AA-161/AA-162)',
    args: [
      '--test',
      'tests/telemetry/usage-rollup.test.ts',
      'tests/telemetry/usage-retention.test.ts',
      // AA-162: the per-company daily surface. Pins the CONCURRENT refresh (a
      // plain one would lock out the dashboards it serves), that it runs only
      // after the rollup rows are durable and only when something changed, that
      // a refresh failure degrades to a stale view rather than a failed pass,
      // and that COGS is never synthesized from a price table.
      'tests/telemetry/daily-company-usage.test.ts',
    ],
  },
  {
    // AA-163: tiered rate cards + the pre-execution plan gate. The gate's risk is
    // asymmetric — a wrong deny blocks a paying customer — so these pin the
    // fail-open paths (flag off, system work, unmetered usage, DB errors) as hard
    // as the one denial path, plus the 402 mapping and that the gate runs before
    // any job state exists. Fully in-memory (injected db).
    name: 'plan rate cards, usage gate, credits + quota alerts (AA-163/AA-164)',
    args: [
      '--test',
      'tests/billing/rate-cards.test.ts',
      'tests/billing/usage-entitlement.test.ts',
      'tests/billing/plan-gate-wiring.test.ts',
      // AA-164: the customer-facing half — the credit ledger that a payment
      // webhook will write to (idempotent under redelivery; corrections are
      // appended, never edited), the quota summary the dashboard renders
      // (unmetered reports NULL, never a confident 0%), the 80/95% alerts
      // (claimed before send, so an hourly sweep can't spam a customer), and
      // the read route's tenant scoping.
      'tests/billing/credit-ledger.test.ts',
      'tests/billing/quota-summary.test.ts',
      'tests/billing/quota-alerts.test.ts',
      'tests/billing/quota-route.test.ts',
    ],
  },
  {
    // AA-90/S1-11 (gap B1): the compose guard for the outage that ticket was
    // misfiled as. The Hermes gateway is a HOST process, so HERMES_GATEWAY_URL
    // is host.docker.internal-scoped; the sync worker had the credentials but
    // NOT the host-gateway mapping, so every classification call died with
    // ENOTFOUND and insights_comment_classifications sat at zero rows for weeks
    // with nothing failing or alerting. No code test can catch that — the
    // requirement lives only in the compose file. Derived from the file, so a
    // NEW Hermes-calling sidecar is covered the day it is added. No DB.
    name: 'compose: Hermes callers can resolve the host gateway (B1)',
    args: ['--test', 'tests/compose-hermes-host-gateway.test.ts'],
  },
  {
    // AA-90/S1-11: the label-quality gate itself. Labels are frozen once
    // written (ON CONFLICT DO NOTHING on a pinned version) and flag-off does
    // NOT roll them back, so a bad first batch is expensive. Pins the
    // mechanical smells (uniform labels, out-of-vocabulary NULLs, everything
    // flagged a lead), that a single row is never mis-flagged as uniform, that
    // "needs_review" is the BEST verdict a script may return, and that the
    // review is read-only. Injected queryable; no DB.
    name: 'insights comment-label quality gate (B1)',
    args: ['--test', 'tests/insights-classification-review.test.ts'],
  },
  {
    // AA-114/S6-1 (gaps A6a/F3): the canonical goal WRITE path — the operator
    // picks the goal instead of it being keyword-guessed from free text. Pins
    // the A6a fix ("Increase social media presence" means content_growth, not
    // the brand_awareness fallback) and its now-load-bearing consequence: since
    // #964 that goal is the one whose metric, SUM(followers_delta), the
    // strategy/publish prompts optimise for, so a mismatch would have the
    // prompts and the dashboard chasing different numbers. Also pins the
    // resolver's precedence — an explicit pick wins, an unrelated field edit
    // never re-derives over it, a changed goal text still re-resolves — and
    // that both keyword heuristics are retired. No DB.
    name: 'canonical goal write path (A6a/F3)',
    args: ['--test', 'tests/goal-canonical-write-path.test.ts'],
  },
  {
    // AA-117/S6-4: structural guards for ops/aries-pipeline-monitor.py — the
    // watchdog that would have caught the 2026-08-06→10 outage (4 days of
    // failed weekly runs, nobody told). It is a HOST script by design, because
    // one condition it alerts on is "the app is dead or wedged" and an in-app
    // outbox cannot report its own absence — which also put it outside every
    // existing test surface, leaving a 62KB alerting script whose own fixture
    // suite nothing ran. Behaviour is covered by its --self-test, now wired
    // into CI (ubuntu; fcntl is POSIX-only so it cannot run on Windows). These
    // pin that the safety net still EXISTS to be run: the self-test, the
    // provider-auth suppression whose over-suppression already hid real 401s
    // once, the redaction promise, read-only DB access, and the stale-cron-path
    // warning. No DB, no Python.
    name: 'ops pipeline monitor guards (S6-4)',
    args: ['--test', 'tests/ops-pipeline-monitor.test.ts'],
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
    // S3-5/AA-101: the sync worker must be able to override the Composio action
    // slug of every adapter it runs. Instagram had none wired while FB, X,
    // YouTube, Reddit and LinkedIn all did — pinning IG to its hardcoded slugs
    // with no .env escape hatch, despite riding the same always-on gate as FB.
    // Pins the general rule so the next adapter cannot repeat it.
    name: 'insights-sync worker adapter slug passthrough (S3-5)',
    args: ['--test', 'tests/insights-sync-worker-adapter-slugs.test.ts'],
  },
  {
    // S2-4/AA-95: day-boundary timezone AGREEMENT guardrail. Pure + no DB, so it
    // runs here on every PR (unlike the S2-3/S2-1 requires-infra tz tests that
    // self-skip in CI). Fails if audience or attention reverts to UTC bucketing.
    name: 'insights day-boundary tz agreement (audience + attention)',
    args: ['--test', 'tests/insights-tz-boundary-agreement.test.ts'],
  },
  {
    // S2-5/AA-96: deterministic pins for the S2-1 (latest-snapshot metric) and
    // S2-3 (tenant-tz window) math — trends pctDelta edges, goal window
    // boundaries incl. DST, top derive+rank. Pure + no DB; a regression here
    // means a refactor silently changed a displayed number or window boundary.
    name: 'insights metric/window math pinning (S2-1 + S2-3)',
    args: ['--test', 'tests/insights-math-pinning.test.ts'],
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
    // S3-2 (gap C1): insights_posts.content_type production writer. The pure
    // caption-keyword classifier (6-bucket coverage, tie-break precedence,
    // null-on-no-signal, vocabulary-lock, and the seed/top-template-builder
    // drift tripwire) plus the dispatcher upsert seam proving the INSERT binds
    // content_type and the ON CONFLICT clause COALESCE-preserves an already
    // classified row. Pure/in-memory, no DB.
    name: 'insights content_type classifier + dispatcher upsert seam',
    args: [
      '--test',
      'tests/insights-content-type-classify.test.ts',
      'tests/insights-dispatcher-leg-isolation.test.ts',
    ],
  },
  {
    // Audit item 5b: object quarantine + account self-heal. A post deleted
    // on-platform used to answer Graph (#100) on every 30-minute tick forever
    // and pin its account's sync run at 'partial' permanently (tenant 15, 72h+).
    // Pins the two things that make quarantine safe rather than a silencer:
    // the two legs have INDEPENDENT strike state (shared state never converges
    // when metrics succeed and comments fail), and the failure write is ONE
    // atomic UPDATE (no read-modify-write race with a concurrent
    // handler-triggered sync). Also pins the orphan sweep's exact predicate —
    // the highest-blast-radius statement in the insights module — including the
    // disconnect case, where the connected_accounts row is DELETED. Fully
    // in-memory (fake pool), no DB.
    name: 'insights object quarantine + account orphan sweep',
    args: [
      '--test',
      'tests/insights-object-health.test.ts',
      'tests/insights-post-quarantine.test.ts',
      'tests/insights-ensure-account.test.ts',
    ],
  },
  {
    // Audit item 5a: the comment classifier was unreachable on EVERY sync
    // because the sync sidecar carried HERMES_GATEWAY_URL but not the
    // host.docker.internal extra_hosts mapping. Pins the boot-time preflight
    // probe's verdicts and the fact that every unreachable detail names the
    // gateway host:port — and never the API key. No network.
    name: 'insights classifier gateway preflight',
    args: [
      '--test',
      'tests/insights-classifier-preflight.test.ts',
      'tests/insights-comment-classification.test.ts',
    ],
  },
  {
    // S3-7/AA-103: attribution coverage gate for the S4-1 all-channel fallback.
    // Pure count math, including empty-window and invalid-input fail-closed
    // behavior; no DB or I/O.
    name: 'insights attribution coverage threshold',
    args: ['--test', 'tests/insights-attribution-coverage.test.ts'],
  },
  {
    // S4-1/AA-104: the Activity/Top attribution scope decision that consumes
    // the S3-7 gate above. Pins the never-re-empty property (#785) across a
    // threshold/count grid, the three fail-open paths, and the default-OFF
    // rollout flag. Fake queryable, no DB or I/O.
    name: 'insights attribution scope decision',
    args: ['--test', 'tests/insights-attribution-scope.test.ts'],
  },
  {
    // S4-5/AA-108 (gap E1): auth + tenant-isolation coverage for EVERY insights
    // GET route — the highest-risk untested read paths with multi-workspace in
    // flight, so this is a never-cut gate. Behavioural: each of the 14 handlers
    // refuses an unauthenticated caller and a membership-less session, and does
    // so before reading any tenant id (a spoofed ?tenantId= changes nothing).
    // Structural: tenantId comes only from the resolved context, every route's
    // read surface scopes with a parameterized tenant_id predicate, and each
    // cached section keys its cache on tenantId (a cache hit serves a body
    // without ever running the scoped query). Route registry is coverage-guarded
    // against app/api/insights, so a new route without tests fails here. No DB.
    name: 'insights route auth + tenant isolation (E1)',
    args: ['--test', 'tests/insights-route-auth-tenant-isolation.test.ts'],
  },
  {
    // S4-6/AA-109 (gap C4): the marketing review tray as the SECOND writer of
    // campaign_learning_labels, so "Working with Aries" stops reading zeros for
    // every tenant who never hand-labeled. Pins the action->label mapping
    // (changes_requested stays distinct from reject — they are the bar's EDITED
    // and REBUILT buckets), the creative+assetId discrimination that stops the
    // publish gate double-counting, the deterministic idempotency key, the
    // non-fatal write contract, the two-place schema rule, and the drift guard
    // tying the emitted vocabulary to what aries-builder actually filters on.
    // Fake query fn, no DB.
    name: 'marketing review -> learning labels writer (C4)',
    args: ['--test', 'tests/marketing/review-learning-labels.test.ts'],
  },
  {
    // S5-1/AA-110 (gap F1b): the weekly results report + its flag-gated route.
    // Pins the week boundary (most-recent COMPLETED ISO week in UTC, incl. the
    // year-boundary and non-existent-W53 cases), the publish-state counts, the
    // reconnect signal coming from oauth_connections rather than a per-post code
    // (there is none), manual_reconciliation staying OUT of `blocked`, the
    // honesty contract (an unavailable ranking carries no post payload), the A1
    // regression (latest snapshot, never a SUM), the bounded ranking window, and
    // the gate short-circuiting before any tenant/DB work. Fake queryable, no DB.
    name: 'weekly results report + route (F1b)',
    args: [
      '--test',
      'tests/weekly-results-report.test.ts',
      'tests/weekly-results-route.test.ts',
    ],
  },
  {
    // S5-3/AA-112 (gap F2a): insights CSV export. Pins RFC-4180 quoting (a
    // caption with a comma must not shift columns), the spreadsheet
    // formula-injection guard (captions are public, untrusted input heading for
    // an operator's Excel), comments refused BY NAME with the PII reason, no
    // exported column carrying commenter details, the S2-1 latest-snapshot read
    // so exported numbers are true, the row clamp, and the pooled client being
    // released BEFORE the response streams. No DB.
    name: 'insights CSV export (F2a)',
    args: ['--test', 'tests/insights-export-csv.test.ts'],
  },
  {
    // S5-4/AA-113 (gap B5): the /insights channel chips are derived from
    // `isPlatformInsightsEnabled` — the same predicate the sync adapter factory
    // uses — so a chip exists exactly when an adapter can produce data for it.
    // The drift this guards is silent in both directions: a chip with no adapter
    // is a filter that can only return nothing, and a missing chip hides a
    // channel that does have data. The shipped fix (#912/#914) was covered only
    // by the CI full suite; gating it here catches a regression pre-push.
    // Renders the real component via react-test-renderer. No DB.
    name: 'insights platform filter truthing (B5)',
    args: ['--test', 'tests/insights-platform-filter-truthing.test.ts'],
  },
  {
    // AA-153: the workspace header eyebrow follows the job's actual kind
    // instead of a hardcoded "Post" (a week-long weekly job read as a single
    // post). Pure resolver + label, no DB or I/O.
    name: 'marketing job kind eyebrow',
    args: ['--test', 'tests/marketing-job-kind.test.ts'],
  },
  {
    // S6-2/AA-115: goal_type backfill with low-confidence flagging. Pins the
    // safety invariant (a confident key always equals the goal the read path
    // already renders, so backfilling never moves a tenant's metric), the
    // refusal to persist the brand_awareness fallthrough, and the NULL ->
    // pre-AA-115 resolution fallback. Fake db, no DB or I/O.
    name: 'insights goal_type backfill + low-confidence flagging',
    args: ['--test', 'tests/insights-goal-type-backfill.test.ts'],
  },
  {
    // S7-4/AA-122: insights cache expiry jitter + per-key singleflight, and the
    // source guarantee that a cache-miss request holds ONE pooled connection
    // instead of two (guardrail #1). Pure policy + source assertions, no DB.
    name: 'insights cache jitter + singleflight + connection budget',
    args: ['--test', 'tests/insights-cache-policy.test.ts'],
  },
  {
    // S7-2/AA-120: the per-tenant/section bound on the authenticated
    // ?force=true cache bypass. Pins both halves of the acceptance bar —
    // scripted hammering yields exactly the burst allowance, and the browser's
    // only force affordance (the Retry button) still recovers, including that
    // hammering while throttled cannot push recovery further out. The
    // load-bearing assertion is source-level: the gate must sit BEFORE
    // pool.connect() in all six handlers, or a denied request still holds the
    // connection the throttle exists to protect. Pure policy, no DB.
    name: 'insights force-bypass throttle (AA-120)',
    args: ['--test', 'tests/insights-force-throttle.test.ts'],
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
    // AA-144 reboot resilience: startup degrades only for classified transient
    // Hermes failures, while the digest-pinned, Aries-scoped unhealthy watcher
    // enforces a durable three-restart/15-minute budget. Pure/in-memory except
    // for the policy's deterministic shell CLI; no Docker daemon is required.
    name: 'startup and unhealthy-container recovery resilience',
    args: [
      '--test',
      'tests/instrumentation-startup-resilience.test.ts',
      'tests/container-autoheal.test.ts',
    ],
  },
  {
    // Compose-service vs deploy-workflow recreate parity. In verify (not just
    // the CI full-suite) because the agent-automerge deploy path gates on
    // verify alone — a compose/deploy drift must fail before that dispatch.
    name: 'deploy manifest parity',
    args: ['--test', 'tests/deploy-manifest-parity.test.ts'],
  },
  {
    // Self-hosted deploy cleanup is destructive host policy. Keep its repository
    // scope, seven-day bound, rollback retention, and nonfatal behavior in the
    // fast gate so a workflow-only edit cannot silently broaden Docker deletion.
    name: 'deploy Docker cleanup safety contract',
    args: ['--test', 'tests/deploy-docker-cleanup.test.ts'],
  },
  {
    // The nightly caller must stay surfacing-only while the reusable Tests
    // workflow remains the single source of truth for the full CI suite.
    name: 'nightly build workflow contract',
    args: ['--test', 'tests/nightly-build-workflow.test.ts'],
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
      'tests/marketing-create-error-mapping.test.ts',
      'tests/marketing-new-job-field-errors.test.ts',
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
    // Weekly performance context (ARIES_PERF_CONTEXT_ENABLED): the env flag
    // (default ON), the pure block formatter + its SQL contract (latest
    // lifetime snapshot, comments_count, caption/permalink sanitisation), and
    // the port-level injection points — strategy prompt on both the
    // approval-resume and auto-advance paths, plus the condensed line on the
    // weekly research request. Fully in-memory.
    name: 'weekly performance context',
    args: [
      '--test',
      'tests/performance-context-env.test.ts',
      'tests/marketing/performance-context.test.ts',
      'tests/marketing/performance-context-injection.test.ts',
    ],
  },
  {
    // Growth objective (audit F1): the DEFAULT_GROWTH_PRIMARY_GOAL string is
    // coupled to normalizeGoal() by KEYWORDS, not by a shared enum — rewording
    // it can silently reclassify the goal and split the Insights goal card from
    // what the content pipeline optimises for. Also pins the KPI contract to
    // the strategy + publish stages only, its subordination clause (a stated
    // non-growth goal stays primary), and that its engagement definition
    // matches what the performance block actually reports. Fully in-memory.
    name: 'growth objective + KPI contract',
    args: [
      '--test',
      'tests/marketing/growth-objective.test.ts',
    ],
  },
  {
    // Research depth (audit item 3): the 28-day performance block reaching the
    // RESEARCH submission (not just the condensed line in Request (JSON)), the
    // 12-call tool budget, and the fact that the mandatory /last30days +
    // performance_signals mandate is WEEKLY-ONLY — the shared tool policy also
    // serves the brand-campaign path on the default gateway, whose profile is
    // not known to carry the skill. Also pins the gateway URL/key pairing
    // warning that covers the docker-compose HERMES_RESEARCH_GATEWAY_URL
    // default (a repointed URL with no per-profile key 401s every research
    // submission). Fully in-memory.
    // agent-reach (ITEM B) rides the same step: it pins that the cookie-auth
    // social-reading skill is offered to the WEEKLY research stage ONLY (the
    // 8642 brand-campaign profile is not known to carry it, and an unknown
    // slash command has no defined no-op — it errors or falls through to
    // `terminal`, i.e. the 600s loop), that its raised 16-call ceiling is
    // likewise weekly-only, and that RESEARCH_TOOL_POLICY is still
    // byte-identical. That last assertion is the one
    // tests/marketing/build-hermes-instructions.test.ts cannot make: its
    // verbatim mirror of the policy does not import the module, so it rots
    // silently rather than failing.
    // The local-cookie test pins the VM-state allowlist and stdin/atomic-transfer
    // security boundaries for the companion desktop refresh bundle.
    name: 'research depth + gateway auth pairing',
    args: [
      '--test',
      'tests/marketing/research-depth.test.ts',
      'tests/marketing/agent-reach-research-policy.test.ts',
      'tests/local-cookie-agent.test.ts',
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
  const result = spawnSync(process.execPath, [tsxBin, ...step.args], {
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
