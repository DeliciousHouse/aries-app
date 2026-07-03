# AI-slop audit — findings and cleanup backlog

- **Date:** 2026-07-02
- **Status:** Wave 1 executed (dead-code removal PR + `.npm-cache` untrack PR); waves 2-4 are backlog
- **Method:** 9 parallel audit dimensions over the full repo (~135k source LOC, 428 test files), every
  "dead / safely removable" claim adversarially verified by an independent agent instructed to refute it
  (static + dynamic imports, string-built paths, npm scripts, CI workflows, docker-compose, Dockerfile,
  app-router path-routing, host cron, operator docs).

## Verdict

The codebase is **not uniformly sloppy — the slop is concentrated**. Comment discipline (8.5% density,
mostly load-bearing constraint docs), route-handler structure (61 of 106 routes are thin delegations,
tenant-auth helper at 83% adoption, internal-secret auth at 100%), and defensive error handling are all
*cleaner* than typical AI-generated code. The real debt is in four places:

1. **Dead parallel implementations** (~8k LOC): whole subsystems scaffolded in March 2026 and abandoned
   when the live implementation took a different path (hand-rolled auth vs next-auth, legacy OAuth vs
   Composio, Veo lane vs the shipped video pipeline, pipeline-intake wizard vs /onboarding/start).
2. **Micro-helper duplication** (~290 clone sites): every generation pass re-derived the same 3-10-line
   helpers instead of importing them.
3. **Test-suite accretion**: one-file-per-fix (clusters of 17-31 files per module), 23% helper adoption,
   and a 49-file genre of brittle source-regex tests.
4. **HTTP-plumbing dialects**: 18 error-payload shapes, 7 hand-rolled Hermes gateway clients, 0/106
   routes using the zod dependency that already ships in package.json.

## Wave 1 — executed

- **PR: untrack `.npm-cache/`** — 473 npm cache blobs (156.4 MiB) tracked since a March merge (#153).
  Removed from the index + gitignored. History rewrite to reclaim pack size is out of scope (needs sign-off).
- **PR: remove verified-dead code** (~9.7k LOC) — every deletion survived adversarial verification;
  test files that read deleted sources by path were co-edited (see the PR description for the full map):
  - `backend/auth/` session subsystem (login/logout/me/session — superseded by next-auth; the RBAC trio
    `permission-check.ts`/`rbac.ts`/`tenant-guard.ts` is **kept**, reserved by
    `docs/plans/2026-06-01-team-roles-policies-ui.md` locked decision #7)
  - `backend/integrations/` legacy OAuth subgraph: `token-store.ts`, `provider-state.ts`,
    `credential-reference.ts`, `meta/{connect,callback,disconnect,status}.ts` (never routed; live Meta
    flow is Composio + `app/api/oauth/meta/select-page`)
  - `backend/video/` (dead March "Veo lane" scaffold; the live video feature ships through
    `ARIES_VIDEO_PUBLISH_ENABLED` paths in marketing/integrations)
  - `backend/creative-memory/{analysis,artifactIngestion,marketPatternNotes}.ts`,
    `backend/marketing/jobs-start.ts`, `lib/api-service.ts` (test-only or zero-reference). The two
    descriptive spec files that named `jobs-start.ts#startMarketingJob` (`marketing_api_contract.v1.json`,
    `marketing_job_contract_spec.v1.json` — loaded by nothing) were re-pointed at the live
    `orchestrator.ts#startSocialContentJob`.
  - OAuth refresh sweeper (`scripts/oauth-refresh-sweep.ts` + `backend/integrations/refresh-sweeper.ts`):
    scheduled by nothing, never ran in prod; on-demand refresh via `/api/oauth/[provider]/refresh` is the
    live path and prod publishing is Composio-managed. Docs corrected. `sendMetaReconnectWarningEmail`
    in `lib/email.ts` retained for the channel-health reconnect-UI track.
  - `frontend/onboarding/pipeline-intake/` wizard (2,121 LOC, unreachable behind a redirect stub — stub kept)
  - `frontend/aries-v1/` orphans: `settings-presenter`, `results-presenter`, `landing-page`,
    `channel-integrations-screen`; `frontend/app-shell/` console trio; `frontend/services/supabase.ts`
    stub graveyard (+ the always-rejecting invite effect in `sign-up-form.tsx`); 9 misc zero-importer files
  - Script graveyard: `smoke-weekly-pipeline`, `backfill-asset-ingest`, `migrate-asset-tenant-prefix`,
    `backfill-html-entities`, `repair-stale-brand-offers`, `refresh-tenant-brand-kit`, `scripts/codemods/`,
    `scripts/standups/`
  - **Gate repairs** (bugs, not deletions): `npm run verify` listed a renamed test file
    (`list-deleted-campaigns-…` → `list-deleted-posts-bounded-parallel.test.ts`) so that test silently ran
    nowhere since 2026-05-27; `test:concurrent` listed `campaign-workspace-state` (renamed in #493) and
    `dashboard-api-security` (never existed); `test:e2e` listed `onboarding-runtime-cutover` (deleted in #404).
    `tsx --test` exits 0 on missing file args, so all four were silent.

## Wave 2 — needs operator sign-off (verified removable, but doc/governance-anchored)

The auto-mode classifier correctly declined these; each was verified dead by the audit but touches
governance/identity files or contracted surfaces:

- **OpenClaw persona layer at repo root** (10 files: `SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, `USER.md`,
  `MEMORY.md`, `TOOLS.md`, `PRIORITIES.md`, `DELEGATION-RULES.md`, `PROTECTED_SYSTEMS.md`, `RUNTIME.md`).
  Nothing consumes them (Hermes profiles use their own profile-local SOUL.md). Removal requires co-edits:
  `scripts/check-repo-boundary.mjs:13-16`, `tests/docs-social-content-guidance.test.ts` (TOOLS.md entry),
  and 3 stale `skills/*/SKILL.md` pointers.
- **`docs/SYSTEM-REFERENCE.md`** — frozen 2026-05-04 output of a deleted generator; co-edit the
  docs-social-content-guidance list + 2 links in `docs/reference/api-jobs-and-callbacks.md`.
- **`ROADMAP.md`** (contains the banned term `n8n`, escapes the ban only because the checker scans a fixed
  file list) + `specs/phase_conductor_spec.v1.json` (dead spec pointing at it), and
  `docs/plans/episode-3-delegation-tradeoff-template.md` (generic non-app template).
- **`lib/api/social-content.ts`** — zero importers, but contracted as part of `ACTIVE_SOCIAL_CONTENT_PATHS`
  in `tests/social-content-execution-contract.test.ts` (runs in verify + required CI). Removing it is a
  deliberate contract change.
- **`backend/tenant/organization-lifecycle.ts`** — unimported, but `TODOS.md:77` documents it as the
  tenant-teardown ordering hook.
- **`gc-orphan-uploads.ts`** — the never-scheduled "reclaim half" of the upload-replace 24h-retention
  design. Decide: wire it into a dormant worker (note: its `DELETE_ROW_SQL` lacks a `storage_kind` filter
  and would also hard-delete hermes-gc-orphaned rows — fix at wiring time) or delete it + the design comments.
- **History rewrite** to reclaim the 156 MiB `.npm-cache` pack bloat (`git filter-repo`) — destructive to
  all clones.

## Wave 3 — helper consolidation (mechanical, high-value)

Counts are verified grep counts, not estimates. One shared module each, then mechanical replacement:

| Clone | Sites | Canonical home |
|---|---|---|
| `X instanceof Error ? X.message : String(X)` | 115× in 69 files | new `lib/error-message.ts` |
| truthy env check (`'1'\|'true'\|'yes'\|'on'`) | 26 files (+11 test clones) | new `lib/env-flag.ts` |
| `asRecord`/`recordValue`/`asObject` (byte-identical) | 28 files | promote `runtime-state.ts:1102` export to `lib/records.ts` |
| `stringValue(value, fallback)` — **3 drifted variants** | 29 files | same module; audit drift first |
| `nowIso()` | 23 files | `runtime-state.ts:223` already exports it |
| positive-int env parser (interval-ms knobs) | ~18 in 14 files | next to `parsePoolMax` (`lib/db-pool-config.ts` precedent, PR #582) |
| fetch-with-timeout wrapper | 10+ sites, 8 files | `lib/api/http.ts` already exists, barely used |
| worker `buildPool()` block | 7 scripts | shared scripts helper |
| `resolveBaseUrl(req)` (2 copies have hardcoded prod hostname) | 5 impls | one lib helper |
| Hermes gateway client (submit+poll, readEnv, tryParseJson) | 7 impls | shared `backend/execution/hermes-client-shared.ts`; the two intentional execution-seam ports keep their envelopes |
| `sleep(ms)` | 8 files | lib one-liner |
| auth-route `parseJson`/`parseCookies` | died with backend/auth removal | — |

## Wave 4 — structural (each needs its own design pass)

- **Error-envelope convergence**: 132 error returns across 18 payload shapes in app/api; converge on the
  dominant `{ error: <snake_case_code> }` (~90 already), one `jsonError` helper, delete 14 local `json()` helpers.
- **`withTenantRoute()` wrapper**: the 4-line loadTenantContextOrResponse+guard idiom repeats at 67 call
  sites (~200 net lines); 10 routes still hand-roll tenant auth entirely.
- **Zod at the route boundary**: zod is already a dependency (used only by `packages/aries-hermes-protocol`);
  36 hand-parsed route bodies with drifted parse helpers.
- **Inline DDL removal**: 3 files run `CREATE TABLE IF NOT EXISTS` in request paths — the exact footgun
  behind the June `is_replied` 500 — vs the canonical `scripts/init-db.js` + `migrations/` path.
- **The two drifted "new job" screens**: `frontend/marketing/new-job.tsx` (638 LOC, routed at
  /dashboard/social-content/new) and `frontend/social-content/new-job.tsx` (489 LOC, also routed) are ~70%
  divergent forks of the same screen. Product decision: which one wins. Likely related to the
  "weekly publish-skip = nowhere to click" defect (the two forms write different publish-config keys).
- **Test-suite consolidation**: merge the worst clusters (brand-kit 17 files, hermes-callback 19 files,
  publish 31, insights 28); extend `tests/helpers/` (temp-DATA_ROOT harness is hand-rolled in 87 files,
  inline fake pool in 45, inline fetch mock in 27); replace the 49-file source-regex genre with behavior
  tests where feasible; normalize the incoherent `regression-NNN` naming (three unrelated files claim 001).
- **God-file splits** (top of list): `dashboard-content.ts` 3,067; `runtime-views.ts` 2,383;
  `orchestrator.ts` 2,373; `hermes-callbacks.ts` 2,227 — 14 files ≥1,000 LOC hold ~25% of backend/lib.
- **tenantId type unification**: declared `string` at 258 sites and `number` at 74, with 42+ boundary
  re-coercions.
- **Doc drift**: 8+ shipped plans still say "Open/draft"; the list-perf plan's "locked decisions" mandate an
  approach later proven infeasible (add Historical banners); TODOS.md is ~half stale; `.env.example` is
  missing 22 documented env vars; CLAUDE.md documents each sidecar twice.
- **Symbol-level dead exports**: 59 definition-only exports + 96 internal-only exports safe to un-export
  (excluding the doc-anchored RBAC/teardown symbols listed by the audit).

## Not slop — do not "clean"

Documented-intentional patterns the audit confirmed should stay: the single-provider execution seam,
per-worker dormant-flag patterns, idempotency re-checks, the verify/full-suite/requires-infra test split,
the long constraint-documenting header comments (e.g. `*-env.ts`), `copy-finalize-handler.ts`
(flag-gated future stage behind `ARIES_SOCIAL_COPY_FINALIZE_ENABLED`), and the `__set…ForTests` seams
(debatable, but load-bearing for the current test approach).
